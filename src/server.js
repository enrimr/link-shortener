// Acortador de enlaces personal. Cinco rutas y ninguna sorpresa:
//   GET  /                             → panel web para crear enlaces
//   POST /api/shorten  {url, prefix?}  → {code, shortUrl}   (solo dominios de la lista blanca;
//                                        prefix opcional: s.enri.me/astroleap/Xk3mP2a)
//   GET  /:code                        → 301 a la URL larga (+1 al contador de visitas)
//   GET  /:prefix/:code                → ídem, para enlaces creados con prefijo
//   GET  /docs                         → documentación interactiva (Scalar sobre docs/openapi.yaml)
//   GET  /healthz                      → ok
//
// Variables de entorno (en Railway: las dos primeras las inyecta el enlace con Postgres):
//   DATABASE_URL   — cadena de conexión de Postgres
//   PORT           — puerto (Railway lo inyecta)
//   ALLOWED_HOSTS  — dominios acortables, separados por comas; admite "*.midominio.com"
//                    (p.ej. "astroleap.enri.me,*.enri.me")
//   BASE_URL       — base pública para construir shortUrl (p.ej. "https://s.enri.me")
//   ADMIN_PASSWORD — opcional; si se define, POST /api/shorten exige
//                    "Authorization: Bearer <contraseña>"...
//   PUBLIC_PREFIXES — ...SALVO para estos prefijos (separados por comas, p.ej. "astroleap"):
//                    acortan sin contraseña, porque el juego llama desde el navegador del
//                    jugador y meter la contraseña en el JS del cliente sería publicarla.
//                    El riesgo queda acotado como en el diseño original: destino en lista
//                    blanca + límite por IP — lo peor posible es crear enlaces hacia MIS
//                    dominios bajo ese prefijo.
//                    Además, las peticiones cuyo Origin es un dominio de ALLOWED_HOSTS pasan
//                    sin contraseña (mis propias webs acortan sin credenciales), con el mismo
//                    riesgo acotado; el host de BASE_URL queda excluido para que el panel siga
//                    pidiéndola.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createDb } from './db.js';
import { shorten, resolve, parseAllowedHosts, isTrustedOrigin, makeRateLimiter, passwordMatches, recordMetric, summarizeMetrics, isValidMetricName } from './core.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_PREFIXES = new Set(String(process.env.PUBLIC_PREFIXES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const BASE_HOST = new URL(BASE_URL).hostname.toLowerCase(); // el panel NO queda exento por Origin

// El panel es un único HTML estático; se lee una vez y se le inyecta si hace falta contraseña.
const INDEX_HTML = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
    .replaceAll('__NEEDS_PASSWORD__', ADMIN_PASSWORD ? 'true' : 'false');

// Documentación interactiva: Scalar renderizando la especificación OpenAPI del repo.
// El prefijo "docs" está reservado en core.js para que ningún enlace corto lo pise.
const DOCS_HTML = readFileSync(new URL('./public/docs.html', import.meta.url), 'utf8');
const OPENAPI_YAML = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');

if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL (en Railway: enlaza el servicio con un Postgres).');
    process.exit(1);
}
if (!ALLOWED_HOSTS.length) {
    console.error('Falta ALLOWED_HOSTS: sin lista blanca esto sería un redirector abierto (spam).');
    process.exit(1);
}

const db = await createDb(process.env.DATABASE_URL);
const allowShorten = makeRateLimiter({ max: 30, windowMs: 60000 });
const allowMetrics = makeRateLimiter({ max: 120, windowMs: 60000 }); // las balizas del juego son frecuentes

function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        // CORS abierto A PROPÓSITO: el juego llama desde el navegador del jugador, y la lista
        // blanca de destinos (no de orígenes) es la que corta el abuso — solo se pueden crear
        // enlaces hacia MIS dominios, los cree quien los cree.
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(data);
}

function readBody(req, limit = 16384) {
    return new Promise((resolvePromise, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('body_too_large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, BASE_URL);

        if (req.method === 'OPTIONS') return json(res, 204, {});
        if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(INDEX_HTML);
        }

        if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(DOCS_HTML);
        }

        if (req.method === 'GET' && url.pathname === '/docs/openapi.yaml') {
            res.writeHead(200, { 'Content-Type': 'application/yaml; charset=utf-8' });
            return res.end(OPENAPI_YAML);
        }

        if (req.method === 'POST' && url.pathname === '/api/shorten') {
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
            if (!allowShorten(ip)) return json(res, 429, { error: 'rate_limited' });
            let payload;
            try { payload = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad_json' }); }
            const prefix = typeof payload.prefix === 'string' ? payload.prefix.trim().toLowerCase() : '';
            // La contraseña protege el acortado libre; pasan sin ella los prefijos públicos y
            // las páginas servidas desde un dominio de la lista blanca (Origin del navegador;
            // barrera blanda — ver isTrustedOrigin), salvo el propio panel. El cuerpo se lee
            // ANTES para conocer el prefijo pedido.
            const trusted = isTrustedOrigin(req.headers.origin || '', ALLOWED_HOSTS, BASE_HOST);
            if (ADMIN_PASSWORD && !PUBLIC_PREFIXES.has(prefix) && !trusted) {
                const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
                if (!passwordMatches(given, ADMIN_PASSWORD)) return json(res, 401, { error: 'unauthorized' });
            }
            const result = await shorten(db, String(payload.url || ''), ALLOWED_HOSTS, prefix);
            if (result.error === 'bad_prefix') return json(res, 400, result);
            if (result.error) return json(res, result.error === 'url_not_allowed' ? 403 : 500, result);
            const shortUrl = result.prefix ? `${BASE_URL}/${result.prefix}/${result.code}` : `${BASE_URL}/${result.code}`;
            return json(res, 200, { code: result.code, prefix: result.prefix, shortUrl });
        }

        // Métricas: escritura abierta (las balizas salen del navegador del jugador, sin
        // credenciales; el nombre validado y el limitador cortan el ruido), lectura privada.
        if (req.method === 'POST' && url.pathname === '/api/metrics') {
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
            if (!allowMetrics(ip)) return json(res, 429, { error: 'rate_limited' });
            let payload;
            // navigator.sendBeacon manda el cuerpo como text/plain: se parsea JSON igual.
            try { payload = JSON.parse(await readBody(req, 1024)); } catch (e) { return json(res, 400, { error: 'bad_json' }); }
            const result = await recordMetric(db, String(payload.site || ''), String(payload.event || ''));
            if (result.error) return json(res, 400, result);
            return json(res, 200, { ok: true });
        }

        const metricsRead = req.method === 'GET' && url.pathname.match(/^\/api\/metrics\/([a-z0-9_-]{1,32})$/);
        if (metricsRead) {
            if (ADMIN_PASSWORD) {
                const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
                if (!passwordMatches(given, ADMIN_PASSWORD)) return json(res, 401, { error: 'unauthorized' });
            }
            if (!isValidMetricName(metricsRead[1])) return json(res, 400, { error: 'bad_metric' });
            const days = Math.max(1, Math.min(365, parseInt(url.searchParams.get('days') || '30', 10) || 30));
            const rows = await db.readMetrics(metricsRead[1], days);
            return json(res, 200, { site: metricsRead[1], days, ...summarizeMetrics(rows) });
        }

        // /:code y /:prefix/:code — resolve exige que el prefijo coincida con el del enlace
        const redirect = req.method === 'GET' && url.pathname.match(/^\/(?:([a-z0-9-]{1,32})\/)?([^/]+)$/);
        if (redirect) {
            const target = await resolve(db, redirect[2], redirect[1] || '');
            if (!target) return json(res, 404, { error: 'not_found' });
            res.writeHead(301, { Location: target, 'Cache-Control': 'public, max-age=86400' });
            return res.end();
        }

        return json(res, 404, { error: 'not_found' });
    } catch (e) {
        console.error(e);
        return json(res, 500, { error: 'internal' });
    }
});

server.listen(PORT, () => console.log(`acortador escuchando en :${PORT} — dominios permitidos: ${ALLOWED_HOSTS.join(', ')}`));

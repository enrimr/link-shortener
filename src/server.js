// Acortador de enlaces personal. Tres rutas y ninguna sorpresa:
//   POST /api/shorten  {url}  → {code, shortUrl}   (solo dominios de la lista blanca)
//   GET  /:code               → 301 a la URL larga (+1 al contador de visitas)
//   GET  /healthz             → ok
//
// Variables de entorno (en Railway: las dos primeras las inyecta el enlace con Postgres):
//   DATABASE_URL   — cadena de conexión de Postgres
//   PORT           — puerto (Railway lo inyecta)
//   ALLOWED_HOSTS  — dominios acortables, separados por comas; admite "*.midominio.com"
//                    (p.ej. "astroleap.enri.me,*.enri.me")
//   BASE_URL       — base pública para construir shortUrl (p.ej. "https://s.enri.me")

import http from 'node:http';
import { createDb } from './db.js';
import { shorten, resolve, parseAllowedHosts, makeRateLimiter } from './core.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

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

function json(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        // CORS abierto A PROPÓSITO: el juego llama desde el navegador del jugador, y la lista
        // blanca de destinos (no de orígenes) es la que corta el abuso — solo se pueden crear
        // enlaces hacia MIS dominios, los cree quien los cree.
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
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

        if (req.method === 'POST' && url.pathname === '/api/shorten') {
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
            if (!allowShorten(ip)) return json(res, 429, { error: 'rate_limited' });
            let payload;
            try { payload = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'bad_json' }); }
            const result = await shorten(db, String(payload.url || ''), ALLOWED_HOSTS);
            if (result.error) return json(res, result.error === 'url_not_allowed' ? 403 : 500, result);
            return json(res, 200, { code: result.code, shortUrl: `${BASE_URL}/${result.code}` });
        }

        if (req.method === 'GET' && /^\/[^/]+$/.test(url.pathname)) {
            const target = await resolve(db, url.pathname.slice(1));
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

// Lógica pura del acortador, separada del servidor HTTP y de Postgres para poder testearla
// en Node sin levantar nada (los handlers reciben la "base de datos" como interfaz).

import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // sin 0/O/1/l/I: los códigos se dictan por voz y se copian a mano
export const CODE_LENGTH = 7;

export function generateCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return code;
}

export function isValidCode(code) {
    return typeof code === 'string' && new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code);
}

// Prefijo opcional de proyecto para el enlace corto (p.ej. "astroleap" → s.enri.me/astroleap/Xk3mP2a).
// Minúsculas, dígitos y guiones; se reservan los nombres que ya son rutas del servidor.
const RESERVED_PREFIXES = new Set(['api', 'healthz', 'docs']);
export function isValidPrefix(prefix) {
    return typeof prefix === 'string' && /^[a-z0-9-]{1,32}$/.test(prefix) && !RESERVED_PREFIXES.has(prefix);
}

// Lista blanca de dominios: SIN ella, un acortador público es un redirector abierto y acaba
// usado para spam/phishing (y el dominio, quemado en las listas negras de los mensajeros).
// ALLOWED_HOSTS admite dominios exactos y comodines de subdominio ("*.enri.me").
export function parseAllowedHosts(raw) {
    return String(raw || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean);
}

export function hostMatchesAllowed(host, allowedHosts) {
    return allowedHosts.some(allowed => {
        if (allowed.startsWith('*.')) {
            const base = allowed.slice(2);
            return host === base || host.endsWith('.' + base);
        }
        return host === allowed;
    });
}

export function isAllowedUrl(rawUrl, allowedHosts) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return false; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (rawUrl.length > 8192) return false; // los tokens de duelo de ASTRO LEAP rondan 1-2K; 8K es margen de sobra
    return hostMatchesAllowed(url.hostname.toLowerCase(), allowedHosts);
}

// Exención de contraseña por origen: una página servida desde un dominio de la lista blanca
// puede acortar sin contraseña (el caso del juego). BARRERA BLANDA a sabiendas: Origin la pone
// el navegador y con curl se falsifica — quien corta el abuso de verdad sigue siendo la lista
// blanca de destinos y el límite por IP. excludeHost deja fuera al propio panel del acortador
// (s.enri.me encaja en *.enri.me y sin esto la contraseña del panel no protegería nada).
export function isTrustedOrigin(origin, allowedHosts, excludeHost) {
    let host;
    try { host = new URL(origin).hostname.toLowerCase(); } catch (e) { return false; }
    if (excludeHost && host === excludeHost) return false;
    return hostMatchesAllowed(host, allowedHosts);
}

// Acorta con deduplicación: la misma URL larga con el mismo prefijo siempre devuelve el mismo
// código (los enlaces de duelo se re-comparten; no tiene sentido acumular filas idénticas).
// Reintenta ante la colisión (improbabilísima: 57^7) de un código ya usado.
export async function shorten(db, rawUrl, allowedHosts, prefix = '') {
    if (prefix !== '' && !isValidPrefix(prefix)) return { error: 'bad_prefix' };
    if (!isAllowedUrl(rawUrl, allowedHosts)) return { error: 'url_not_allowed' };
    const existing = await db.findByUrl(rawUrl, prefix);
    if (existing) return { code: existing.code, prefix };
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const result = await db.insert(code, rawUrl, prefix);
        if (result === 'ok') return { code, prefix };
        if (result === 'url_exists') {
            // carrera: otra petición insertó la misma URL entre el findByUrl y nuestro insert
            const winner = await db.findByUrl(rawUrl, prefix);
            if (winner) return { code: winner.code, prefix };
        }
        // 'code_collision' (57^7 ≈ 2×10^12 códigos: casi imposible) → otro intento
    }
    return { error: 'code_collision' }; // 5 colisiones seguidas: algo va muy mal
}

// El prefijo forma parte de la dirección: /astroleap/Xk3mP2a solo redirige si el enlace se
// creó con ese prefijo (y /Xk3mP2a, solo si se creó sin ninguno).
export async function resolve(db, code, prefix = '') {
    if (!isValidCode(code)) return null;
    const row = await db.findByCode(code);
    if (!row || (row.prefix || '') !== prefix) return null;
    db.recordHit(code).catch(() => { /* el contador es cortesía, no debe tumbar la redirección */ });
    return row.url;
}

// ---- Métricas de uso (contadores agregados por sitio/evento/día) ----
// Diseño de privacidad por construcción: la tabla solo guarda (site, event, day, count) —
// ni IP, ni user-agent, ni identificadores. No hay nada personal que proteger ni banner que
// enseñar: literalmente solo se cuenta cuántas veces pasó cada cosa cada día.
export function isValidMetricName(s) {
    return typeof s === 'string' && /^[a-z0-9_-]{1,32}$/.test(s);
}

export async function recordMetric(db, site, event) {
    if (!isValidMetricName(site) || !isValidMetricName(event)) return { error: 'bad_metric' };
    await db.bumpMetric(site, event);
    return { ok: true };
}

// Resumen para la lectura: filas por día + totales por evento del periodo.
export function summarizeMetrics(rows) {
    const totals = {};
    for (const r of rows) totals[r.event] = (totals[r.event] || 0) + Number(r.count);
    return { events: rows, totals };
}

// Comparación de contraseñas en tiempo constante: se comparan los SHA-256 (mismo tamaño
// siempre) para que ni la longitud ni el contenido de la contraseña afecten al tiempo.
export function passwordMatches(given, expected) {
    const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
    const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
    return crypto.timingSafeEqual(a, b);
}

// Limitador de peticiones por IP, en memoria (token bucket simple). Para un servicio personal
// no hace falta Redis: si el proceso se reinicia, el cubo se vacía y no pasa nada.
export function makeRateLimiter({ max = 30, windowMs = 60000 } = {}) {
    const buckets = new Map();
    return function allow(ip) {
        const now = Date.now();
        const bucket = buckets.get(ip);
        if (!bucket || now - bucket.start > windowMs) {
            buckets.set(ip, { start: now, count: 1 });
            if (buckets.size > 10000) buckets.clear(); // válvula de memoria
            return true;
        }
        bucket.count++;
        return bucket.count <= max;
    };
}

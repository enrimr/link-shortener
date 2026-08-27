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

// Lista blanca de dominios: SIN ella, un acortador público es un redirector abierto y acaba
// usado para spam/phishing (y el dominio, quemado en las listas negras de los mensajeros).
// ALLOWED_HOSTS admite dominios exactos y comodines de subdominio ("*.enri.me").
export function parseAllowedHosts(raw) {
    return String(raw || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean);
}

export function isAllowedUrl(rawUrl, allowedHosts) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { return false; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (rawUrl.length > 8192) return false; // los tokens de duelo de ASTRO LEAP rondan 1-2K; 8K es margen de sobra
    const host = url.hostname.toLowerCase();
    return allowedHosts.some(allowed => {
        if (allowed.startsWith('*.')) {
            const base = allowed.slice(2);
            return host === base || host.endsWith('.' + base);
        }
        return host === allowed;
    });
}

// Acorta con deduplicación: la misma URL larga siempre devuelve el mismo código (los enlaces
// de duelo se re-comparten; no tiene sentido acumular filas idénticas). Reintenta ante la
// colisión (improbabilísima: 57^7) de un código ya usado.
export async function shorten(db, rawUrl, allowedHosts) {
    if (!isAllowedUrl(rawUrl, allowedHosts)) return { error: 'url_not_allowed' };
    const existing = await db.findByUrl(rawUrl);
    if (existing) return { code: existing.code };
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateCode();
        const result = await db.insert(code, rawUrl);
        if (result === 'ok') return { code };
        if (result === 'url_exists') {
            // carrera: otra petición insertó la misma URL entre el findByUrl y nuestro insert
            const winner = await db.findByUrl(rawUrl);
            if (winner) return { code: winner.code };
        }
        // 'code_collision' (57^7 ≈ 2×10^12 códigos: casi imposible) → otro intento
    }
    return { error: 'code_collision' }; // 5 colisiones seguidas: algo va muy mal
}

export async function resolve(db, code) {
    if (!isValidCode(code)) return null;
    const row = await db.findByCode(code);
    if (!row) return null;
    db.recordHit(code).catch(() => { /* el contador es cortesía, no debe tumbar la redirección */ });
    return row.url;
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

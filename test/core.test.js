// Tests de la lógica pura (node --test): sin Postgres ni HTTP — la "base de datos" es un mock
// en memoria que implementa la misma interfaz que src/db.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, isValidCode, parseAllowedHosts, isAllowedUrl, isValidPrefix, isTrustedOrigin, shorten, resolve, makeRateLimiter, passwordMatches, CODE_LENGTH } from '../src/core.js';

function memoryDb() {
    const byCode = new Map(), byUrl = new Map();
    const urlKey = (url, prefix) => `${prefix}\n${url}`;
    return {
        async findByUrl(url, prefix) { const k = urlKey(url, prefix); return byUrl.has(k) ? { code: byUrl.get(k) } : null; },
        async findByCode(code) { return byCode.get(code) || null; },
        async insert(code, url, prefix) {
            if (byUrl.has(urlKey(url, prefix))) return 'url_exists';
            if (byCode.has(code)) return 'code_collision';
            byCode.set(code, { url, prefix }); byUrl.set(urlKey(url, prefix), code);
            return 'ok';
        },
        async recordHit() {},
        hits: byCode
    };
}

const HOSTS = parseAllowedHosts('astroleap.enri.me, *.enri.me');

test('los códigos tienen la longitud y el alfabeto esperados (sin 0/O/1/l/I)', () => {
    for (let i = 0; i < 200; i++) {
        const code = generateCode();
        assert.equal(code.length, CODE_LENGTH);
        assert.ok(isValidCode(code), code);
        assert.ok(!/[0O1lI]/.test(code), code);
    }
});

test('la lista blanca acepta dominios exactos y comodines, y rechaza el resto', () => {
    assert.ok(isAllowedUrl('https://astroleap.enri.me/?duelo=abc', HOSTS));
    assert.ok(isAllowedUrl('https://s.enri.me/x', HOSTS));       // *.enri.me
    assert.ok(isAllowedUrl('https://enri.me/x', HOSTS));         // el comodín cubre también la raíz
    assert.ok(!isAllowedUrl('https://evil.com/?q=1', HOSTS));
    assert.ok(!isAllowedUrl('https://enri.me.evil.com/', HOSTS)); // sufijo falso: el clásico bypass
    assert.ok(!isAllowedUrl('javascript:alert(1)', HOSTS));
    assert.ok(!isAllowedUrl('ftp://astroleap.enri.me/', HOSTS));
    assert.ok(!isAllowedUrl('no-es-una-url', HOSTS));
    assert.ok(!isAllowedUrl('https://astroleap.enri.me/?x=' + 'a'.repeat(9000), HOSTS)); // demasiado larga
});

test('shorten deduplica: la misma URL devuelve siempre el mismo código', async () => {
    const db = memoryDb();
    const a = await shorten(db, 'https://astroleap.enri.me/?duelo=abc', HOSTS);
    const b = await shorten(db, 'https://astroleap.enri.me/?duelo=abc', HOSTS);
    const c = await shorten(db, 'https://astroleap.enri.me/?duelo=OTRO', HOSTS);
    assert.equal(a.code, b.code);
    assert.notEqual(a.code, c.code);
});

test('shorten rechaza dominios fuera de la lista blanca', async () => {
    const db = memoryDb();
    assert.deepEqual(await shorten(db, 'https://evil.com/', HOSTS), { error: 'url_not_allowed' });
});

test('shorten sobrevive a la carrera "misma URL a la vez": recupera el código del ganador', async () => {
    // Simula la carrera: el primer findByUrl no ve nada, el insert choca con url_exists
    // (otro proceso insertó entre medias), y el findByUrl siguiente ya ve al ganador.
    let phase = 0;
    const db = {
        async findByUrl() { return phase >= 2 ? { code: 'GANADOR7' } : null; },
        async findByCode() { return null; },
        async insert() { phase = 2; return 'url_exists'; },
        async recordHit() {}
    };
    phase = 1;
    const result = await shorten(db, 'https://astroleap.enri.me/?duelo=carrera', HOSTS);
    assert.equal(result.code, 'GANADOR7');
});

test('resolve devuelve la URL para un código válido y null para basura', async () => {
    const db = memoryDb();
    const { code } = await shorten(db, 'https://astroleap.enri.me/?duelo=xyz', HOSTS);
    assert.equal(await resolve(db, code), 'https://astroleap.enri.me/?duelo=xyz');
    assert.equal(await resolve(db, 'NOEXISTE'), null);
    assert.equal(await resolve(db, '../etc/passwd'), null);
    assert.equal(await resolve(db, ''), null);
});

test('los prefijos válidos pasan y los reservados o con mayúsculas no', () => {
    assert.ok(isValidPrefix('astroleap'));
    assert.ok(isValidPrefix('mi-proyecto-2'));
    assert.ok(!isValidPrefix('api'));        // reservado: ruta del servidor
    assert.ok(!isValidPrefix('healthz'));    // reservado: ruta del servidor
    assert.ok(!isValidPrefix('AstroLeap')); // solo minúsculas
    assert.ok(!isValidPrefix('con/barra'));
    assert.ok(!isValidPrefix('a'.repeat(33)));
    assert.ok(!isValidPrefix(''));
});

test('el prefijo forma parte del enlace: dedup por (url, prefijo) y resolve exige coincidencia', async () => {
    const db = memoryDb();
    const url = 'https://astroleap.enri.me/?duelo=abc';
    const conPrefijo = await shorten(db, url, HOSTS, 'astroleap');
    const repetido = await shorten(db, url, HOSTS, 'astroleap');
    const sinPrefijo = await shorten(db, url, HOSTS);
    assert.equal(conPrefijo.code, repetido.code);              // misma URL + mismo prefijo → mismo código
    assert.notEqual(conPrefijo.code, sinPrefijo.code);         // sin prefijo es otro enlace
    assert.equal(await resolve(db, conPrefijo.code, 'astroleap'), url);
    assert.equal(await resolve(db, conPrefijo.code), null);           // sin prefijo no resuelve
    assert.equal(await resolve(db, conPrefijo.code, 'otro'), null);   // con otro prefijo tampoco
    assert.equal(await resolve(db, sinPrefijo.code), url);
    assert.deepEqual(await shorten(db, url, HOSTS, 'Astro Leap'), { error: 'bad_prefix' });
});

test('isTrustedOrigin exime a los dominios de la lista blanca pero nunca al propio panel', () => {
    assert.ok(isTrustedOrigin('https://astroleap.enri.me', HOSTS, 's.enri.me'));
    assert.ok(isTrustedOrigin('https://otro.enri.me', HOSTS, 's.enri.me'));      // *.enri.me
    assert.ok(!isTrustedOrigin('https://s.enri.me', HOSTS, 's.enri.me'));        // el panel, excluido
    assert.ok(!isTrustedOrigin('https://evil.com', HOSTS, 's.enri.me'));
    assert.ok(!isTrustedOrigin('https://enri.me.evil.com', HOSTS, 's.enri.me')); // sufijo falso
    assert.ok(!isTrustedOrigin('', HOSTS, 's.enri.me'));                          // sin Origin (curl)
    assert.ok(!isTrustedOrigin('null', HOSTS, 's.enri.me'));                      // Origin "null" (sandbox)
});

test('passwordMatches acepta la contraseña exacta y rechaza variantes y vacíos', () => {
    assert.ok(passwordMatches('secreta123', 'secreta123'));
    assert.ok(!passwordMatches('secreta12', 'secreta123'));
    assert.ok(!passwordMatches('SECRETA123', 'secreta123'));
    assert.ok(!passwordMatches('', 'secreta123'));
    assert.ok(!passwordMatches(undefined, 'secreta123'));
});

test('el limitador de peticiones corta al pasar el máximo y se renueva con la ventana', () => {
    const allow = makeRateLimiter({ max: 3, windowMs: 1000 });
    assert.ok(allow('1.2.3.4'));
    assert.ok(allow('1.2.3.4'));
    assert.ok(allow('1.2.3.4'));
    assert.ok(!allow('1.2.3.4'));   // el 4º cae
    assert.ok(allow('5.6.7.8'));    // otra IP, su propio cubo
});

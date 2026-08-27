// Tests de la lógica pura (node --test): sin Postgres ni HTTP — la "base de datos" es un mock
// en memoria que implementa la misma interfaz que src/db.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateCode, isValidCode, parseAllowedHosts, isAllowedUrl, shorten, resolve, makeRateLimiter, CODE_LENGTH } from '../src/core.js';

function memoryDb() {
    const byCode = new Map(), byUrl = new Map();
    return {
        async findByUrl(url) { return byUrl.has(url) ? { code: byUrl.get(url) } : null; },
        async findByCode(code) { return byCode.has(code) ? { url: byCode.get(code) } : null; },
        async insert(code, url) {
            if (byUrl.has(url)) return 'url_exists';
            if (byCode.has(code)) return 'code_collision';
            byCode.set(code, url); byUrl.set(url, code);
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

test('el limitador de peticiones corta al pasar el máximo y se renueva con la ventana', () => {
    const allow = makeRateLimiter({ max: 3, windowMs: 1000 });
    assert.ok(allow('1.2.3.4'));
    assert.ok(allow('1.2.3.4'));
    assert.ok(allow('1.2.3.4'));
    assert.ok(!allow('1.2.3.4'));   // el 4º cae
    assert.ok(allow('5.6.7.8'));    // otra IP, su propio cubo
});

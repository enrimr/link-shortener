// Tests del colector de métricas (node --test): lógica pura contra un mock en memoria que
// implementa bumpMetric/readMetrics — sin Postgres, como el resto del repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidMetricName, recordMetric, summarizeMetrics } from '../src/core.js';

function memoryMetrics() {
    const counts = new Map(); // "site|event" → n (un solo día simulado)
    return {
        async bumpMetric(site, event) {
            const k = `${site}|${event}`;
            counts.set(k, (counts.get(k) || 0) + 1);
        },
        async readMetrics(site) {
            return [...counts.entries()]
                .filter(([k]) => k.startsWith(site + '|'))
                .map(([k, count]) => ({ event: k.split('|')[1], day: '2026-08-27', count }));
        }
    };
}

test('los nombres de sitio/evento válidos pasan y la basura no', () => {
    assert.ok(isValidMetricName('astroleap'));
    assert.ok(isValidMetricName('reto_ok'));
    assert.ok(isValidMetricName('duelo-2'));
    assert.ok(!isValidMetricName('AstroLeap'));      // solo minúsculas
    assert.ok(!isValidMetricName('con espacio'));
    assert.ok(!isValidMetricName('a'.repeat(33)));   // demasiado largo
    assert.ok(!isValidMetricName(''));
    assert.ok(!isValidMetricName('<script>'));
});

test('recordMetric valida y acumula; los nombres inválidos ni tocan la base', async () => {
    const db = memoryMetrics();
    assert.deepEqual(await recordMetric(db, 'astroleap', 'visita'), { ok: true });
    assert.deepEqual(await recordMetric(db, 'astroleap', 'visita'), { ok: true });
    assert.deepEqual(await recordMetric(db, 'astroleap', 'victoria'), { ok: true });
    assert.deepEqual(await recordMetric(db, 'MAL', 'visita'), { error: 'bad_metric' });
    assert.deepEqual(await recordMetric(db, 'astroleap', ''), { error: 'bad_metric' });
    const rows = await db.readMetrics('astroleap');
    const visita = rows.find(r => r.event === 'visita');
    assert.equal(visita.count, 2); // el contador agrega, no acumula filas
});

test('summarizeMetrics devuelve filas y totales por evento', () => {
    const rows = [
        { event: 'visita', day: '2026-08-27', count: 5 },
        { event: 'visita', day: '2026-08-26', count: '3' }, // pg devuelve BIGINT como string
        { event: 'victoria', day: '2026-08-27', count: 1 }
    ];
    const s = summarizeMetrics(rows);
    assert.deepEqual(s.totals, { visita: 8, victoria: 1 });
    assert.equal(s.events.length, 3);
});

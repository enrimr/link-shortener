// Capa Postgres, detrás de la interfaz mínima que consume core.js:
//   findByUrl(url, prefix) → {code} | null · findByCode(code) → {url, prefix} | null
//   insert(code, url, prefix) → 'ok' | 'url_exists' | 'code_collision' · recordHit(code)
// Railway inyecta DATABASE_URL al enlazar el servicio con su Postgres.

import pg from 'pg';

export async function createDb(connectionString) {
    const pool = new pg.Pool({
        connectionString,
        // Railway Postgres exige TLS desde fuera de su red privada; dentro (railway.internal)
        // no lo necesita. `sslmode` viaja en la propia URL, así que no forzamos nada aquí.
        max: 5
    });
    await pool.query(`
        CREATE TABLE IF NOT EXISTS links (
            code       TEXT PRIMARY KEY,
            url        TEXT NOT NULL,
            prefix     TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            hits       BIGINT NOT NULL DEFAULT 0
        )
    `);
    // Migración desde el esquema inicial (sin prefijo, url UNIQUE): la deduplicación pasa a
    // ser por (url, prefix) — la misma URL puede tener un código por cada prefijo.
    await pool.query(`ALTER TABLE links ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE links DROP CONSTRAINT IF EXISTS links_url_key`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS links_url_prefix_key ON links (url, prefix)`);
    // Métricas: contadores agregados por (sitio, evento, día) — ver recordMetric en core.js.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS metrics (
            site  TEXT NOT NULL,
            event TEXT NOT NULL,
            day   DATE NOT NULL DEFAULT current_date,
            count BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (site, event, day)
        )
    `);
    return {
        async findByUrl(url, prefix) {
            const r = await pool.query('SELECT code FROM links WHERE url = $1 AND prefix = $2', [url, prefix]);
            return r.rows[0] || null;
        },
        async findByCode(code) {
            const r = await pool.query('SELECT url, prefix FROM links WHERE code = $1', [code]);
            return r.rows[0] || null;
        },
        async insert(code, url, prefix) {
            // Devuelve 'ok' | 'url_exists' (carrera: otro insertó la misma URL antes — el
            // llamador debe re-consultar el código real) | 'code_collision' (reintentar).
            try {
                await pool.query('INSERT INTO links (code, url, prefix) VALUES ($1, $2, $3)', [code, url, prefix]);
                return 'ok';
            } catch (e) {
                if (e.code === '23505' && /url/.test(e.constraint || '')) return 'url_exists';
                if (e.code === '23505') return 'code_collision';
                throw e;
            }
        },
        async recordHit(code) {
            await pool.query('UPDATE links SET hits = hits + 1 WHERE code = $1', [code]);
        },
        async bumpMetric(site, event) {
            await pool.query(`
                INSERT INTO metrics (site, event, day, count) VALUES ($1, $2, current_date, 1)
                ON CONFLICT (site, event, day) DO UPDATE SET count = metrics.count + 1
            `, [site, event]);
        },
        async readMetrics(site, days) {
            const r = await pool.query(`
                SELECT event, day::text, count FROM metrics
                WHERE site = $1 AND day >= current_date - $2::int
                ORDER BY day DESC, event
            `, [site, days]);
            return r.rows;
        },
        async close() { await pool.end(); }
    };
}

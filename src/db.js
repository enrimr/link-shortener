// Capa Postgres, detrás de la interfaz mínima que consume core.js:
//   findByUrl(url) → {code} | null · findByCode(code) → {url} | null
//   insert(code, url) → bool (false si el código colisiona) · recordHit(code)
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
            url        TEXT NOT NULL UNIQUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            hits       BIGINT NOT NULL DEFAULT 0
        )
    `);
    return {
        async findByUrl(url) {
            const r = await pool.query('SELECT code FROM links WHERE url = $1', [url]);
            return r.rows[0] || null;
        },
        async findByCode(code) {
            const r = await pool.query('SELECT url FROM links WHERE code = $1', [code]);
            return r.rows[0] || null;
        },
        async insert(code, url) {
            // Devuelve 'ok' | 'url_exists' (carrera: otro insertó la misma URL antes — el
            // llamador debe re-consultar el código real) | 'code_collision' (reintentar).
            try {
                await pool.query('INSERT INTO links (code, url) VALUES ($1, $2)', [code, url]);
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
        async close() { await pool.end(); }
    };
}

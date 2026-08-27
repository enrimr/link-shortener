# link-shortener

Acortador de enlaces personal, pensado como backend compartido para mis proyectos (el primero: los duelos de [ASTRO LEAP](https://astroleap.enri.me/), cuyas URL con fantasma rondan los 1.200 caracteres).

**Diseño en una línea**: `POST /api/shorten {url}` → `{code, shortUrl}` · `GET /:code` → redirección 301 · **lista blanca de dominios de destino** (sin ella, un acortador público es un redirector abierto y acaba usado para spam/phishing).

## API

```bash
# acortar (solo URLs hacia dominios de ALLOWED_HOSTS)
curl -X POST https://s.enri.me/api/shorten \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://astroleap.enri.me/?duelo=TOKEN_LARGUISIMO"}'
# → {"code":"Xk3mP2a","shortUrl":"https://s.enri.me/Xk3mP2a"}

curl -I https://s.enri.me/Xk3mP2a   # → 301 Location: https://astroleap.enri.me/?duelo=...
```

- La misma URL larga devuelve siempre el mismo código (deduplicación).
- Códigos de 7 caracteres sin `0/O/1/l/I` (se dictan por voz sin ambigüedad); espacio de 57⁷ ≈ 2 billones.
- CORS abierto **a propósito**: quien corta el abuso es la lista blanca de *destinos*, no de orígenes.
- Límite de 30 acortados/minuto por IP (en memoria — suficiente para uso personal).
- `GET /healthz` para el healthcheck del despliegue. La tabla lleva contador de visitas (`hits`).

## Variables de entorno

| Variable | Ejemplo | Notas |
|---|---|---|
| `DATABASE_URL` | *(la inyecta Railway)* | Postgres; la tabla se crea sola al arrancar |
| `ALLOWED_HOSTS` | `astroleap.enri.me,*.enri.me` | separados por comas; `*.dominio` cubre subdominios y la raíz |
| `BASE_URL` | `https://s.enri.me` | base pública para construir `shortUrl` |
| `PORT` | *(la inyecta Railway)* | |

## Desplegar en Railway

1. `railway init` (o crear proyecto en el dashboard) y **añadir un servicio Postgres** al proyecto.
2. Crear el servicio de la app desde este repo (`railway up`, o conectando el repo de GitHub). Railway detecta Node y usa `npm start` — no hace falta Dockerfile.
3. En variables del servicio: enlazar `DATABASE_URL` como referencia al Postgres (`${{Postgres.DATABASE_URL}}`), y definir `ALLOWED_HOSTS` y `BASE_URL`.
4. Generar dominio (o apuntar `s.enri.me` como dominio custom) y sanity check: `curl https://<dominio>/healthz`.

## Desarrollo

```bash
npm install
npm test                      # lógica pura, sin Postgres (node --test)
DATABASE_URL=postgres://... ALLOWED_HOSTS=localhost BASE_URL=http://localhost:3000 npm start
```

La lógica vive en `src/core.js` (pura, testeada con una BD en memoria), Postgres en `src/db.js` y el HTTP en `src/server.js` — tres ficheros, cero frameworks, una dependencia (`pg`).

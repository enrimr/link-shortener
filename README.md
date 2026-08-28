# link-shortener

Acortador de enlaces personal, pensado como backend compartido para mis proyectos (el primero: los duelos de [ASTRO LEAP](https://astroleap.enri.me/), cuyas URL con fantasma rondan los 1.200 caracteres). En producción en **https://s.enri.me** (Railway; deploy automático con cada push a `main`).

**Diseño en una línea**: `POST /api/shorten {url, prefix?}` → `{code, shortUrl}` · `GET /:code` (o `/:prefijo/:code`) → redirección 301 · `GET /` → panel web · **lista blanca de dominios de destino** (sin ella, un acortador público es un redirector abierto y acaba usado para spam/phishing).

## Rutas

| Ruta | Qué hace |
|---|---|
| `GET /` | Panel web: crear enlaces y consultar métricas (pide contraseña si el servidor la exige) |
| `POST /api/shorten` | Acorta `{url, prefix?}` → `{code, prefix, shortUrl}` |
| `GET /:code` | 301 a la URL larga (+1 al contador de visitas) |
| `GET /:prefijo/:code` | Ídem para enlaces creados con prefijo — el prefijo debe coincidir |
| `POST /api/metrics` | Baliza `{site, event}` → incrementa un contador agregado |
| `GET /api/metrics/:site?days=30` | Lectura de métricas (privada) |
| `GET /docs` | Documentación interactiva de la API ([Scalar](https://scalar.com) sobre el `openapi.yaml`) |
| `GET /healthz` | Healthcheck del despliegue |

- La misma URL larga (con el mismo prefijo) devuelve siempre el mismo código (deduplicación).
- Códigos de 7 caracteres sin `0/O/1/l/I` (se dictan por voz sin ambigüedad); espacio de 57⁷ ≈ 2 billones.
- El **prefijo** es opcional y nombra el proyecto en el propio enlace: `s.enri.me/astroleap/Xk3mP2a`. Minúsculas, dígitos y guiones (máx. 32); `api`, `healthz` y `docs` reservados.
- CORS abierto **a propósito**: quien corta el abuso es la lista blanca de *destinos*, no de orígenes.
- Límite de 30 acortados/minuto por IP y 120 balizas/minuto (en memoria — suficiente para uso personal).

## Autenticación

Con `ADMIN_PASSWORD` definida, `POST /api/shorten` exige `Authorization: Bearer <contraseña>`… con dos excepciones pensadas para que **mis webs acorten sin credenciales** (embeber la contraseña en el JS del cliente sería publicarla):

1. **`Origin` de confianza**: si la cabecera `Origin` (la pone el navegador) es un dominio de `ALLOWED_HOSTS`, no hace falta contraseña. El host de `BASE_URL` queda excluido para que el panel siga pidiéndola.
2. **`PUBLIC_PREFIXES`**: los prefijos listados en esa variable acortan sin contraseña.

Ambas son barreras blandas *a sabiendas* (`Origin` se falsifica con `curl`): el abuso real lo cortan la lista blanca de destinos y el límite por IP — lo peor posible es crear enlaces hacia mis propios dominios.

## Probar la API

Lo más cómodo: **https://s.enri.me/docs** — documentación interactiva (Scalar) servida por el propio acortador, con todas las rutas, esquemas y ejemplos, y un cliente para lanzar peticiones desde el navegador.

Y en el repo, en [`docs/`](docs/):

- [**`openapi.yaml`**](docs/openapi.yaml) — especificación OpenAPI 3 completa. Impórtala en Postman/Insomnia/Bruno (File → Import) o pégala en [editor.swagger.io](https://editor.swagger.io) para verla renderizada.
- [**`link-shortener.postman_collection.json`**](docs/link-shortener.postman_collection.json) — colección de Postman con los casos felices y los de error (401/403/400/404), tests automáticos y variables `baseUrl`/`adminPassword`; el código creado se guarda solo y lo reutilizan las peticiones de redirección.
- [**`api.http`**](docs/api.http) — las mismas peticiones para lanzar desde el editor (extensión REST Client de VS Code o el HTTP Client de IntelliJ).

O a mano:

```bash
# acortar (solo URLs hacia dominios de ALLOWED_HOSTS)
curl -X POST https://s.enri.me/api/shorten \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <contraseña>' \
  -d '{"url":"https://astroleap.enri.me/?duelo=TOKEN_LARGUISIMO","prefix":"astroleap"}'
# → {"code":"Xk3mP2a","prefix":"astroleap","shortUrl":"https://s.enri.me/astroleap/Xk3mP2a"}

curl -I https://s.enri.me/astroleap/Xk3mP2a   # → 301 Location: https://astroleap.enri.me/?duelo=...
```

## Herramientas MCP para agentes

El acortador se puede usar como herramientas MCP de dos formas — remota (sin instalar nada) o local (stdio):

| Herramienta | Qué hace |
|---|---|
| `acortar_url` | Acorta `{url, prefix?}` → `{code, prefix, shortUrl}` |
| `leer_metricas` | Lee los contadores de un sitio (`{site, days?}`) |
| `registrar_evento` | Suma una baliza `{site, event}` |
| `estado_acortador` | Healthcheck + base URL configurada |

**Remoto (Streamable HTTP)** — el propio servicio expone `POST /mcp`, protegido con `ADMIN_PASSWORD` (todo el endpoint: acortar vía MCP es privilegiado y aquí no hay `Origin` de navegador que valga). Sin estado a propósito: cada petición es independiente. Para Cline, Claude Code o cualquier cliente MCP con soporte HTTP:

```json
{
  "mcpServers": {
    "acortador": {
      "type": "streamableHttp",
      "url": "https://s.enri.me/mcp",
      "headers": { "Authorization": "Bearer <contraseña>" }
    }
  }
}
```

(En Claude Code: `claude mcp add --transport http acortador https://s.enri.me/mcp --header "Authorization: Bearer <contraseña>"`.)

**Local (stdio)** — [`mcp/server.js`](mcp/server.js), un cliente fino de la API HTTP. En este repo ya está registrado vía [`.mcp.json`](.mcp.json) — Claude Code lo detecta al abrir el proyecto; solo hace falta exportar la contraseña (`export SHORTENER_ADMIN_PASSWORD=…`) y `cd mcp && npm install` la primera vez.

En ambos casos, toda la lógica y la seguridad (lista blanca, límites) siguen en el servidor.

## Métricas de uso (opcional)

El mismo servicio recoge **contadores agregados** de mis proyectos — privacidad por construcción: la tabla solo guarda `(sitio, evento, día, total)`; ni IP, ni user-agent, ni cookies, ni identificadores. Nada personal → nada de banner.

```bash
# baliza (la manda el juego con navigator.sendBeacon; escritura abierta, validada y con límite por IP)
curl -X POST https://s.enri.me/api/metrics -d '{"site":"astroleap","event":"visita"}'

# lectura (privada: exige ADMIN_PASSWORD si está definida)
curl -H 'Authorization: Bearer <contraseña>' 'https://s.enri.me/api/metrics/astroleap?days=30'
# → {"site":"astroleap","days":30,"events":[{"event":"visita","day":"2026-08-27","count":42},...],"totals":{"visita":410,"victoria":7}}
```

También sin terminal: el panel `/` tiene una pestaña **Métricas** (misma contraseña, que ya recuerda el navegador) con los totales del periodo y una tabla día × evento.

Eventos que manda ASTRO LEAP: `visita`, `partida`, `reto`, `duelo`, `reto_ok`, `victoria`, `gameover`.

Y uno que genera el propio acortador: **`enlace_abierto`** — cada redirección suma en las métricas del sitio del prefijo (los enlaces `/astroleap/…` cuentan en `astroleap`; los enlaces sin prefijo, en el sitio `acortador`). KPI de enlaces abiertos por proyecto y día, sin tocar a los clientes. Ojo a la letra pequeña: el 301 lleva `Cache-Control` de un día, así que las aperturas repetidas desde el mismo navegador no vuelven a pasar por el servidor (le pasa igual al `hits` por enlace) — es un KPI de alcance, no de clics exactos.

## Variables de entorno

| Variable | Ejemplo | Notas |
|---|---|---|
| `DATABASE_URL` | *(la inyecta Railway)* | Postgres; la tabla se crea sola al arrancar (con migración automática del esquema) |
| `ALLOWED_HOSTS` | `astroleap.enri.me,*.enri.me` | separados por comas; `*.dominio` cubre subdominios y la raíz |
| `BASE_URL` | `https://s.enri.me` | base pública para construir `shortUrl` |
| `PORT` | *(la inyecta Railway)* | |
| `ADMIN_PASSWORD` | `una-buena-contraseña` | **opcional**; protege el acortado y la lectura de métricas (ver [Autenticación](#autenticación)) |
| `PUBLIC_PREFIXES` | `astroleap` | **opcional**; prefijos que acortan **sin contraseña** |

## Despliegue

En producción corre en Railway con **deploy automático**: el servicio está conectado a este repo y cada push a `main` construye y despliega solo (healthcheck en `/healthz` — el deploy no se da por bueno hasta que responde). Para reproducirlo desde cero:

1. `railway up` desde este directorio (crea proyecto + servicio; Railway detecta Node y usa `npm start` — no hace falta Dockerfile) y **añadir un servicio Postgres** al proyecto.
2. En variables del servicio: enlazar `DATABASE_URL` como referencia al Postgres (`${{Postgres.DATABASE_URL}}`) y definir `ALLOWED_HOSTS`, `BASE_URL` y `ADMIN_PASSWORD`.
3. Conectar el repo de GitHub al servicio para el deploy automático, generar dominio (o apuntar el custom, `s.enri.me` vía CNAME) y sanity check: `curl https://<dominio>/healthz`.

## Desarrollo

```bash
npm install
npm test        # lógica pura, sin Postgres (node --test)

# Postgres desechable para el servidor local (ojo: el 5432 puede estar ocupado por un Postgres nativo)
docker run -d --name link-shortener-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=links -p 5433:5432 postgres:16-alpine

DATABASE_URL='postgres://postgres:dev@127.0.0.1:5433/links' \
ALLOWED_HOSTS='astroleap.enri.me,*.enri.me' \
BASE_URL='http://localhost:3000' \
ADMIN_PASSWORD='secreta123' \
npm start       # panel en http://localhost:3000
```

La lógica vive en `src/core.js` (pura, testeada con una BD en memoria), Postgres en `src/db.js`, el HTTP en `src/server.js`, el endpoint MCP en `src/mcp.js` y el panel en `src/public/index.html` — cero frameworks; dependencias: `pg` y el SDK oficial de MCP (`@modelcontextprotocol/sdk` + `zod`).

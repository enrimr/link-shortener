// Endpoint MCP remoto (Streamable HTTP, sin estado): expone las mismas herramientas que
// mcp/server.js pero corriendo dentro del propio servicio — llama a core/db directamente,
// sin vuelta por la API HTTP. server.js lo monta en POST /mcp (protegido con ADMIN_PASSWORD).
//
// Sin estado a propósito: servidor y transporte nuevos por petición (enableJsonResponse:
// respuestas JSON planas, sin SSE) — no hay sesiones que guardar y cada réplica es equivalente.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { shorten, recordMetric, summarizeMetrics, isValidMetricName } from './core.js';

export function createMcpHandler({ db, allowedHosts, baseUrl }) {
    const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    const fail = msg => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

    function buildServer() {
        const server = new McpServer({ name: 'acortador-enri-me', version: '1.0.0' });

        server.registerTool('acortar_url', {
            title: 'Acortar URL',
            description: 'Crea un enlace corto para una URL de los dominios permitidos. Devuelve {code, prefix, shortUrl}. ' +
                'La misma URL con el mismo prefijo devuelve siempre el mismo código.',
            inputSchema: {
                url: z.string().url().describe('URL larga a acortar; su dominio debe estar en la lista blanca'),
                prefix: z.string().regex(/^[a-z0-9-]{1,32}$/).optional()
                    .describe('Prefijo de proyecto opcional; forma parte del enlace (/astroleap/Xk3mP2a)')
            }
        }, async ({ url, prefix }) => {
            const result = await shorten(db, url, allowedHosts, prefix || '');
            if (result.error) return fail(result.error);
            const shortUrl = result.prefix ? `${baseUrl}/${result.prefix}/${result.code}` : `${baseUrl}/${result.code}`;
            return ok({ code: result.code, prefix: result.prefix, shortUrl });
        });

        server.registerTool('leer_metricas', {
            title: 'Leer métricas de un sitio',
            description: 'Contadores agregados de un sitio: filas por día + totales por evento. Sitios: los prefijos de ' +
                'proyecto (p.ej. "astroleap") y "acortador" (enlaces sin prefijo). enlace_abierto es el KPI de aperturas.',
            inputSchema: {
                site: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Sitio a consultar'),
                days: z.number().int().min(1).max(365).optional().describe('Días hacia atrás (por defecto 30)')
            }
        }, async ({ site, days }) => {
            if (!isValidMetricName(site)) return fail('bad_metric');
            const rows = await db.readMetrics(site, days || 30);
            return ok({ site, days: days || 30, ...summarizeMetrics(rows) });
        });

        server.registerTool('registrar_evento', {
            title: 'Registrar un evento de métricas',
            description: 'Suma +1 al contador agregado (sitio, evento, día). Sin datos personales — solo el total diario.',
            inputSchema: {
                site: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Sitio, p.ej. "astroleap"'),
                event: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Evento, p.ej. "visita" o "victoria"')
            }
        }, async ({ site, event }) => {
            const result = await recordMetric(db, site, event);
            return result.error ? fail(result.error) : ok(result);
        });

        server.registerTool('estado_acortador', {
            title: 'Estado del acortador',
            description: 'Comprueba que el servicio responde y devuelve su base URL pública.',
            inputSchema: {}
        }, async () => ok({ ok: true, baseUrl }));

        return server;
    }

    return async function handleMcp(req, res, parsedBody) {
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,   // sin estado
            enableJsonResponse: true         // JSON plano en vez de SSE
        });
        res.on('close', () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
    };
}

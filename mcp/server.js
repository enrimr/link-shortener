#!/usr/bin/env node
// Servidor MCP (stdio) del acortador: envuelve la API HTTP de s.enri.me para que los agentes
// (Claude Code y compañía) acorten enlaces y consulten métricas como herramientas nativas.
// Es un cliente fino de la API — toda la lógica y la seguridad viven en el servidor.
//
// Variables de entorno:
//   SHORTENER_BASE_URL        — base del servicio (por defecto https://s.enri.me)
//   SHORTENER_ADMIN_PASSWORD  — la ADMIN_PASSWORD del servicio; sin ella, acortar y leer
//                               métricas fallarán con 401 si el servidor exige contraseña

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = (process.env.SHORTENER_BASE_URL || 'https://s.enri.me').replace(/\/$/, '');
const PASSWORD = process.env.SHORTENER_ADMIN_PASSWORD || '';

async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && PASSWORD) headers['Authorization'] = `Bearer ${PASSWORD}`;
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${data.error || 'error'}`);
    return data;
}

// Los resultados de las herramientas son JSON en texto: los agentes lo parsean sin problema
// y no dependemos de tipos de contenido más allá de "text".
const ok = data => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = e => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'acortador-enri-me', version: '1.0.0' });

server.registerTool('acortar_url', {
    title: 'Acortar URL',
    description: 'Crea un enlace corto para una URL de los dominios permitidos (astroleap.enri.me, *.enri.me). ' +
        'Devuelve {code, prefix, shortUrl}. La misma URL con el mismo prefijo devuelve siempre el mismo código.',
    inputSchema: {
        url: z.string().url().describe('URL larga a acortar; su dominio debe estar en la lista blanca del servidor'),
        prefix: z.string().regex(/^[a-z0-9-]{1,32}$/).optional()
            .describe('Prefijo de proyecto opcional; forma parte del enlace (/astroleap/Xk3mP2a). "api", "healthz" y "docs" reservados')
    }
}, async ({ url, prefix }) => {
    try { return ok(await api('/api/shorten', { method: 'POST', body: { url, ...(prefix && { prefix }) }, auth: true })); }
    catch (e) { return fail(e); }
});

server.registerTool('leer_metricas', {
    title: 'Leer métricas de un sitio',
    description: 'Lee los contadores agregados de un sitio (filas por día + totales por evento). Sitios: los prefijos de ' +
        'proyecto (p.ej. "astroleap") y "acortador" (enlaces sin prefijo). El evento enlace_abierto es el KPI de aperturas. ' +
        'Requiere SHORTENER_ADMIN_PASSWORD.',
    inputSchema: {
        site: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Sitio a consultar, p.ej. "astroleap" o "acortador"'),
        days: z.number().int().min(1).max(365).optional().describe('Días hacia atrás (por defecto 30)')
    }
}, async ({ site, days }) => {
    try { return ok(await api(`/api/metrics/${site}${days ? `?days=${days}` : ''}`, { auth: true })); }
    catch (e) { return fail(e); }
});

server.registerTool('registrar_evento', {
    title: 'Registrar un evento de métricas',
    description: 'Suma +1 al contador agregado (sitio, evento, día). Escritura abierta y sin datos personales — ' +
        'solo se guarda el total diario.',
    inputSchema: {
        site: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Sitio, p.ej. "astroleap"'),
        event: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Evento, p.ej. "visita" o "victoria"')
    }
}, async ({ site, event }) => {
    try { return ok(await api('/api/metrics', { method: 'POST', body: { site, event } })); }
    catch (e) { return fail(e); }
});

server.registerTool('estado_acortador', {
    title: 'Estado del acortador',
    description: 'Comprueba que el servicio responde (healthcheck) y contra qué base URL está apuntando este servidor MCP.',
    inputSchema: {}
}, async () => {
    try { return ok({ baseUrl: BASE_URL, ...(await api('/healthz')) }); }
    catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());

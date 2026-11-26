import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createFigeloMcpServer } from '../hub/mcp-tools.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/protocol.js';
import { ensureHubRunning } from './ensure-hub.js';

interface ApiCallResponse {
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

async function callHubApi(
  host: string,
  port: number,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://${host}:${port}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });

  const payload = (await response.json()) as ApiCallResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || `Hub HTTP ${response.status}`);
  }
  return payload.result;
}

export async function startStdioBridge(): Promise<void> {
  const host = process.env.FIGELO_HOST ?? DEFAULT_HOST;
  const preferredPort = parseInt(process.env.FIGELO_PORT ?? String(DEFAULT_PORT), 10);

  let hub = await ensureHubRunning(host, preferredPort);
  console.error(
    `[FigeloMCP stdio] connected to shared Hub at http://${hub.host}:${hub.port}` +
      (hub.spawned ? ' (spawned background daemon)' : ' (existing daemon)'),
  );

  const server = createFigeloMcpServer(async (toolName, args) => {
    try {
      return await callHubApi(hub.host, hub.port, toolName, args);
    } catch (err) {
      // If Hub restarted or died unexpectedly, re-ensure once and retry
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        hub = await ensureHubRunning(host, preferredPort);
        return await callHubApi(hub.host, hub.port, toolName, args);
      }
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[FigeloMCP stdio] MCP bridge ready on stdio');
}

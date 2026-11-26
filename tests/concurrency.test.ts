import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { startHubServer, type HubRuntime } from '../src/hub/server.js';

function connectMockPlugin(
  url: string,
  channel: string,
  documentName: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'plugin_hello',
          channel,
          documentName,
          fileKey: `key-${channel}`,
          currentPage: 'Page 1',
          pluginVersion: '0.1.0',
        }),
      );
      resolve(ws);
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        id?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (msg.type === 'request' && msg.id) {
        // Simulate variable Figma execution latency (5–25ms) to stress concurrency
        const delay = 5 + Math.floor(Math.random() * 20);
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              type: 'response',
              id: msg.id,
              result: {
                handledByChannel: channel,
                documentName,
                method: msg.method,
                echoName: msg.params?.name ?? msg.params?.characters ?? null,
              },
            }),
          );
        }, delay);
      }
    });
    ws.on('error', reject);
  });
}

describe('FigeloMCP Multi-Client Concurrency & Unicast Routing', () => {
  let hub: HubRuntime;
  let pluginA: WebSocket;
  let pluginB: WebSocket;
  let baseUrl: string;
  let wsUrl: string;

  beforeAll(async () => {
    hub = await startHubServer({ port: 0, host: '127.0.0.1', writePidFile: false });
    baseUrl = `http://127.0.0.1:${hub.port}`;
    wsUrl = `ws://127.0.0.1:${hub.port}`;
    pluginA = await connectMockPlugin(wsUrl, 'doc-a', 'Design System');
    pluginB = await connectMockPlugin(wsUrl, 'doc-b', 'Mobile App');
    // Give Hub a tick to process both plugin_hello frames
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    pluginA?.close();
    pluginB?.close();
    await hub?.close();
  });

  it('serves /health, /status, and /api/tools with both Figma documents registered', async () => {
    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as {
      ok: boolean;
      plugins: Array<{ channel: string; documentName: string }>;
    };
    expect(health.ok).toBe(true);
    expect(health.plugins.map((p) => p.channel).sort()).toEqual(['doc-a', 'doc-b']);

    const toolsRes = await fetch(`${baseUrl}/api/tools`);
    expect(toolsRes.status).toBe(200);
    const toolsJson = (await toolsRes.json()) as {
      ok: boolean;
      tools: Array<{ name: string }>;
    };
    expect(toolsJson.ok).toBe(true);
    expect(toolsJson.tools.some((t) => t.name === 'create_frame')).toBe(true);
    expect(toolsJson.tools.some((t) => t.name === 'execute_figma_js')).toBe(true);
  });

  it('handles 5 concurrent clients (3 HTTP MCP + 1 REST + 1 WS) without eviction or cross-talk', async () => {
    // 1. Connect 3 independent Streamable HTTP MCP clients (Antigravity, Claude Code, Codex)
    const mcpNames = ['antigravity', 'claude-code', 'codex'] as const;
    const mcpClients: Array<{ name: string; client: Client; transport: StreamableHTTPClientTransport }> = [];

    for (const name of mcpNames) {
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
      const client = new Client({ name, version: '1.0.0' });
      await client.connect(transport);
      mcpClients.push({ name, client, transport });
    }

    // 2. Connect 1 direct WebSocket client (simulating t3code / custom harness)
    const directWs = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(wsUrl);
      sock.on('open', () => {
        sock.send(JSON.stringify({ type: 'client_hello', clientName: 't3code' }));
        resolve(sock);
      });
      sock.on('error', reject);
    });

    const callDirectWs = (id: string, tool: string, args: Record<string, unknown>) =>
      new Promise<{ handledByChannel: string; echoName: string }>((resolve, reject) => {
        const onMessage = (raw: WebSocket.RawData) => {
          const msg = JSON.parse(raw.toString()) as {
            type: string;
            id?: string;
            result?: { handledByChannel: string; echoName: string };
            error?: { message: string };
          };
          if (msg.id !== id) return;
          directWs.off('message', onMessage);
          if (msg.type === 'result' && msg.result) {
            resolve(msg.result);
          } else {
            reject(new Error(msg.error?.message || 'WS call failed'));
          }
        };
        directWs.on('message', onMessage);
        directWs.send(JSON.stringify({ type: 'call', id, tool, args }));
      });

    // 3. Fire concurrent requests from ALL 5 clients simultaneously
    const mcpPromises = mcpClients.map(async ({ name, client }, idx) => {
      const targetChannel = idx % 2 === 0 ? 'doc-a' : 'doc-b';
      const marker = `frame-from-${name}`;
      const res = await client.callTool({
        name: 'create_frame',
        arguments: { name: marker, width: 200, height: 100, channel: targetChannel },
      });
      const text = (res.content as Array<{ type: string; text: string }>)[0].text;
      const parsed = JSON.parse(text) as { handledByChannel: string; echoName: string };
      return { name, targetChannel, marker, parsed };
    });

    const atelierRestPromise = fetch(`${baseUrl}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'create_frame',
        args: { name: 'frame-from-atelier', width: 320, height: 180, channel: 'doc-a' },
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; result: { handledByChannel: string; echoName: string } }>);

    const t3codeWsPromise = callDirectWs('ws-req-1', 'create_text', {
      characters: 'text-from-t3code',
      channel: 'doc-b',
    });

    const [mcpResults, atelierResult, t3codeResult] = await Promise.all([
      Promise.all(mcpPromises),
      atelierRestPromise,
      t3codeWsPromise,
    ]);

    // Verify zero cross-talk across all 3 MCP clients
    for (const item of mcpResults) {
      expect(item.parsed.handledByChannel).toBe(item.targetChannel);
      expect(item.parsed.echoName).toBe(item.marker);
    }

    // Verify Atelier REST result
    expect(atelierResult.ok).toBe(true);
    expect(atelierResult.result.handledByChannel).toBe('doc-a');
    expect(atelierResult.result.echoName).toBe('frame-from-atelier');

    // Verify t3code WS result
    expect(t3codeResult.handledByChannel).toBe('doc-b');
    expect(t3codeResult.echoName).toBe('text-from-t3code');

    // Verify Hub status shows all active sessions cleanly
    const statusRes = await fetch(`${baseUrl}/status`);
    const statusJson = (await statusRes.json()) as {
      mcpSessions: number;
      wsClients: number;
      stats: { totalSuccess: number; totalErrors: number };
    };
    expect(statusJson.mcpSessions).toBe(3);
    expect(statusJson.wsClients).toBe(1);
    expect(statusJson.stats.totalSuccess).toBe(5);
    expect(statusJson.stats.totalErrors).toBe(0);

    // Cleanup clients
    directWs.close();
    for (const { client, transport } of mcpClients) {
      await transport.close();
      await client.close();
    }
  });
});

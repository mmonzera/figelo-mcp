import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  FIGELO_VERSION,
  HEARTBEAT_INTERVAL_MS,
  PORT_RANGE,
  type HubDiscoveryInfo,
  type WireMessage,
} from '../shared/protocol.js';
import {
  createFigeloMcpServer,
  executeToolWithBroker,
  getToolsJsonSchemas,
} from './mcp-tools.js';
import { PluginBroker } from './plugin-broker.js';

export const FIGELO_STATE_DIR = join(homedir(), '.figelo-mcp');
export const FIGELO_HUB_FILE = join(FIGELO_STATE_DIR, 'hub.json');

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface StartHubOptions {
  port?: number;
  host?: string;
  writePidFile?: boolean;
}

export interface HubRuntime {
  port: number;
  host: string;
  server: HttpServer;
  wss: WebSocketServer;
  broker: PluginBroker;
  close: () => Promise<void>;
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Authorization',
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 10 * 1024 * 1024;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function writeDiscoveryFile(info: HubDiscoveryInfo): void {
  mkdirSync(FIGELO_STATE_DIR, { recursive: true });
  writeFileSync(FIGELO_HUB_FILE, JSON.stringify(info, null, 2), 'utf8');
}

export function readDiscoveryFile(): HubDiscoveryInfo | null {
  try {
    if (!existsSync(FIGELO_HUB_FILE)) return null;
    const raw = readFileSync(FIGELO_HUB_FILE, 'utf8');
    return JSON.parse(raw) as HubDiscoveryInfo;
  } catch {
    return null;
  }
}

function removeDiscoveryFile(expectedPort?: number): void {
  try {
    if (!existsSync(FIGELO_HUB_FILE)) return;
    if (expectedPort !== undefined) {
      const info = readDiscoveryFile();
      if (info && info.pid !== process.pid && info.port !== expectedPort) return;
    }
    unlinkSync(FIGELO_HUB_FILE);
  } catch {
    // ignore
  }
}

function tryListen(
  host: string,
  port: number,
  writePidFile: boolean,
): Promise<HubRuntime> {
  return new Promise((resolve, reject) => {
    const broker = new PluginBroker();
    const mcpSessions = new Map<string, McpSession>();
    const wsClients = new Set<WebSocket>();
    const startedAt = Date.now();
    let settled = false;

    const updateCounts = () => {
      broker.setClientCounts({
        mcpSessions: mcpSessions.size,
        wsClients: wsClients.size,
      });
    };

    const server = createServer(async (req, res) => {
      setCorsHeaders(res);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = new URL(req.url || '/', `http://${host}:${actualPort}`);

      try {
        // ─── Health & Status ───
        if (req.method === 'GET' && url.pathname === '/health') {
          const snapshot = broker.getStatusSnapshot();
          writeJson(res, 200, {
            ok: true,
            name: 'FigeloMCP',
            version: FIGELO_VERSION,
            host,
            port: actualPort,
            uptimeMs: Date.now() - startedAt,
            ...snapshot,
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/status') {
          writeJson(res, 200, {
            ok: true,
            version: FIGELO_VERSION,
            host,
            port: actualPort,
            uptimeMs: Date.now() - startedAt,
            ...broker.getStatusSnapshot(),
          });
          return;
        }

        // ─── REST Tool Discovery & Execution (for Atelier, custom harnesses, stdio bridge) ───
        if (req.method === 'GET' && url.pathname === '/api/tools') {
          writeJson(res, 200, {
            ok: true,
            tools: getToolsJsonSchemas(),
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/call') {
          const body = (await readJsonBody(req)) as
            | { tool?: string; args?: Record<string, unknown>; channel?: string }
            | undefined;

          if (!body || typeof body.tool !== 'string' || !body.tool.trim()) {
            writeJson(res, 400, {
              ok: false,
              error: { code: 'BAD_REQUEST', message: 'Body must include non-empty "tool" string' },
            });
            return;
          }

          const mergedArgs: Record<string, unknown> = {
            ...(body.args && typeof body.args === 'object' ? body.args : {}),
          };
          if (body.channel && !mergedArgs.channel) {
            mergedArgs.channel = body.channel;
          }

          try {
            const result = await executeToolWithBroker(broker, body.tool, mergedArgs);
            writeJson(res, 200, { ok: true, result });
          } catch (err) {
            writeJson(res, 400, {
              ok: false,
              error: {
                code: 'TOOL_ERROR',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
          return;
        }

        // ─── Streamable HTTP MCP Endpoint (/mcp) ───
        if (url.pathname === '/mcp') {
          const rawSessionId = req.headers['mcp-session-id'];
          const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

          if (req.method === 'POST') {
            const parsedBody = await readJsonBody(req);

            if (sessionId) {
              const existing = mcpSessions.get(sessionId);
              if (!existing) {
                writeJson(res, 404, {
                  jsonrpc: '2.0',
                  error: { code: -32001, message: 'MCP session not found' },
                  id: null,
                });
                return;
              }
              await existing.transport.handleRequest(req, res, parsedBody);
              return;
            }

            if (!isInitializeRequest(parsedBody)) {
              writeJson(res, 400, {
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: Missing Mcp-Session-Id or initialize request' },
                id: null,
              });
              return;
            }

            const mcpServer = createFigeloMcpServer((toolName, args) =>
              executeToolWithBroker(broker, toolName, args),
            );

            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                mcpSessions.set(sid, { transport, server: mcpServer });
                updateCounts();
              },
              onsessionclosed: (sid) => {
                mcpSessions.delete(sid);
                updateCounts();
              },
            });

            transport.onclose = () => {
              const sid = transport.sessionId;
              if (sid && mcpSessions.has(sid)) {
                mcpSessions.delete(sid);
                updateCounts();
              }
            };

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
            return;
          }

          if (req.method === 'GET' || req.method === 'DELETE') {
            if (!sessionId || !mcpSessions.has(sessionId)) {
              writeJson(res, sessionId ? 404 : 400, {
                jsonrpc: '2.0',
                error: {
                  code: -32000,
                  message: sessionId ? 'MCP session not found' : 'Missing Mcp-Session-Id header',
                },
                id: null,
              });
              return;
            }
            const existing = mcpSessions.get(sessionId)!;
            await existing.transport.handleRequest(req, res);
            return;
          }

          writeJson(res, 405, { ok: false, error: 'Method not allowed on /mcp' });
          return;
        }

        writeJson(res, 404, { ok: false, error: 'Not found' });
      } catch (err) {
        if (!res.headersSent) {
          writeJson(res, 500, {
            ok: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    });

    const wss = new WebSocketServer({ server });

    wss.on('connection', (ws) => {
      let role: 'unknown' | 'plugin' | 'client' = 'unknown';
      let alive = true;

      ws.on('pong', () => {
        alive = true;
      });

      const heartbeat = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);

      ws.on('message', async (raw) => {
        let msg: WireMessage;
        try {
          msg = JSON.parse(raw.toString()) as WireMessage;
        } catch {
          return;
        }

        if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
          }
          return;
        }

        if (msg.type === 'plugin_hello') {
          role = 'plugin';
          if (wsClients.has(ws)) {
            wsClients.delete(ws);
            updateCounts();
          }
          broker.registerPlugin(ws, msg);
          return;
        }

        if (msg.type === 'response' || msg.type === 'error' || msg.type === 'progress') {
          broker.handlePluginMessage(msg);
          return;
        }

        if (msg.type === 'client_hello') {
          role = 'client';
          if (!wsClients.has(ws)) {
            wsClients.add(ws);
            updateCounts();
          }
          return;
        }

        if (msg.type === 'call') {
          if (role === 'unknown') {
            role = 'client';
            wsClients.add(ws);
            updateCounts();
          }
          const callArgs: Record<string, unknown> = { ...(msg.args ?? {}) };
          if (msg.channel && !callArgs.channel) {
            callArgs.channel = msg.channel;
          }
          try {
            const result = await executeToolWithBroker(broker, msg.tool, callArgs);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'result',
                  id: msg.id,
                  ok: true,
                  result,
                }),
              );
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'result_error',
                  id: msg.id,
                  ok: false,
                  error: {
                    code: 'TOOL_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                  },
                }),
              );
            }
          }
        }
      });

      ws.on('close', () => {
        clearInterval(heartbeat);
        if (role === 'plugin') {
          broker.unregisterPluginBySocket(ws);
        }
        if (wsClients.delete(ws)) {
          updateCounts();
        }
      });

      ws.on('error', () => {
        // close event will handle cleanup
      });
    });

    server.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    server.on('listening', () => {
      settled = true;
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;

      if (writePidFile) {
        writeDiscoveryFile({
          pid: process.pid,
          port: actualPort,
          host,
          startedAt: new Date(startedAt).toISOString(),
          version: FIGELO_VERSION,
        });
      }

      const close = async (): Promise<void> => {
        broker.rejectAllPending('FigeloMCP Hub shutting down');
        for (const session of mcpSessions.values()) {
          await session.transport.close().catch(() => {});
          await session.server.close().catch(() => {});
        }
        mcpSessions.clear();
        for (const client of wss.clients) {
          try {
            client.close(1001, 'Hub shutting down');
          } catch {
            // ignore
          }
        }
        await new Promise<void>((resClose) => {
          wss.close(() => {
            server.close(() => resClose());
          });
        });
        if (writePidFile) {
          removeDiscoveryFile(actualPort);
        }
      };

      resolve({
        port: actualPort,
        host,
        server,
        wss,
        broker,
        close,
      });
    });

    server.listen(port, host);
  });
}

export async function startHubServer(options: StartHubOptions = {}): Promise<HubRuntime> {
  const host = options.host ?? process.env.FIGELO_HOST ?? DEFAULT_HOST;
  const preferredPort =
    options.port !== undefined
      ? options.port
      : parseInt(process.env.FIGELO_PORT ?? String(DEFAULT_PORT), 10);
  const writePidFile = options.writePidFile ?? true;

  const candidates =
    preferredPort === 0
      ? [0]
      : [preferredPort, ...PORT_RANGE.filter((p) => p !== preferredPort)];

  for (const port of candidates) {
    try {
      return await tryListen(host, port, writePidFile);
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`All FigeloMCP Hub ports (${candidates.join(', ')}) are in use`);
}

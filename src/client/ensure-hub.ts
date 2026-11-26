import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiscoveryFile } from '../hub/server.js';
import { DEFAULT_HOST, DEFAULT_PORT, PORT_RANGE, type PluginMetadata } from '../shared/protocol.js';

export interface HubHealthResponse {
  ok: boolean;
  name: string;
  version: string;
  host: string;
  port: number;
  uptimeMs: number;
  activeChannel: string | null;
  plugins: PluginMetadata[];
  pendingRequests: number;
  mcpSessions: number;
  wsClients: number;
  totalClients: number;
}

export function probeHubHealth(
  host: string,
  port: number,
  timeoutMs = 1200,
): Promise<HubHealthResponse | null> {
  return new Promise((resolveProbe) => {
    const req = httpRequest(
      {
        host,
        port,
        path: '/health',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume();
          resolveProbe(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HubHealthResponse;
            resolveProbe(parsed.ok && parsed.name === 'FigeloMCP' ? parsed : null);
          } catch {
            resolveProbe(null);
          }
        });
      },
    );
    req.on('error', () => resolveProbe(null));
    req.on('timeout', () => {
      req.destroy();
      resolveProbe(null);
    });
    req.end();
  });
}

export async function findRunningHub(
  preferredHost = process.env.FIGELO_HOST ?? DEFAULT_HOST,
  preferredPort = parseInt(process.env.FIGELO_PORT ?? String(DEFAULT_PORT), 10),
): Promise<{ host: string; port: number; health: HubHealthResponse } | null> {
  const discovery = readDiscoveryFile();
  if (discovery) {
    const health = await probeHubHealth(discovery.host || preferredHost, discovery.port);
    if (health) {
      return { host: discovery.host || preferredHost, port: discovery.port, health };
    }
  }

  const ports = [preferredPort, ...PORT_RANGE.filter((p) => p !== preferredPort)];
  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      health: await probeHubHealth(preferredHost, port),
    })),
  );

  const found = results.find((r) => r.health !== null);
  if (found && found.health) {
    return { host: preferredHost, port: found.port, health: found.health };
  }
  return null;
}

export function resolveCliEntryPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // When bundled in dist/cli.js or dist/index.js, cli.js sits in the same directory
  const siblingCli = resolve(currentDir, 'cli.js');
  if (existsSync(siblingCli)) return siblingCli;

  const distCli = resolve(currentDir, '..', '..', 'dist', 'cli.js');
  if (existsSync(distCli)) return distCli;

  return resolve(process.argv[1] || siblingCli);
}

export function spawnDetachedHub(
  port = parseInt(process.env.FIGELO_PORT ?? String(DEFAULT_PORT), 10),
  host = process.env.FIGELO_HOST ?? DEFAULT_HOST,
): number | undefined {
  const cliPath = resolveCliEntryPath();
  const child = spawn(
    process.execPath,
    [cliPath, 'start', '--port', String(port), '--host', host],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    },
  );
  child.unref();
  return child.pid;
}

export async function ensureHubRunning(
  preferredHost = process.env.FIGELO_HOST ?? DEFAULT_HOST,
  preferredPort = parseInt(process.env.FIGELO_PORT ?? String(DEFAULT_PORT), 10),
): Promise<{ host: string; port: number; health: HubHealthResponse; spawned: boolean }> {
  const existing = await findRunningHub(preferredHost, preferredPort);
  if (existing) {
    return { ...existing, spawned: false };
  }

  spawnDetachedHub(preferredPort, preferredHost);

  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const found = await findRunningHub(preferredHost, preferredPort);
    if (found) {
      return { ...found, spawned: true };
    }
  }

  throw new Error(
    `Timed out waiting for FigeloMCP Hub daemon to start on ${preferredHost}:${preferredPort}`,
  );
}

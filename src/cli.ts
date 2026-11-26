#!/usr/bin/env node

import { readDiscoveryFile, startHubServer } from './hub/server.js';
import {
  ensureHubRunning,
  findRunningHub,
  spawnDetachedHub,
} from './client/ensure-hub.js';
import { startStdioBridge } from './client/hub-client.js';
import { installService, uninstallService } from './service/autostart.js';
import {
  CONNECTOR_TARGETS,
  connectApps,
  disconnectApps,
  type ConnectorActionResult,
  type ConnectorTarget,
} from './service/connectors.js';
import { DEFAULT_HOST, DEFAULT_PORT, FIGELO_VERSION } from './shared/protocol.js';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return undefined;
}

function printSetupGuide(host: string, port: number): void {
  const mcpUrl = `http://${host}:${port}/mcp`;
  const apiUrl = `http://${host}:${port}/api/call`;
  const wsUrl = `ws://${host}:${port}`;

  console.log(`
=== FigeloMCP v${FIGELO_VERSION} Setup Guide ===

1) Start the shared Hub once (or install auto-start):
   figelo-mcp start -d
   figelo-mcp install-service

2) Auto-connect all detected AI apps (Claude Desktop, Claude Code, Codex, Antigravity, Cursor):
   figelo-mcp connect
   (Or target one app: figelo-mcp connect claude-desktop)

3) Streamable HTTP MCP (for custom connectors or manual config):
   URL: ${mcpUrl}

   JSON mcpServers snippet:
   {
     "mcpServers": {
       "figelo": {
         "url": "${mcpUrl}"
       }
     }
   }

4) Stdio MCP Fallback (for clients that only accept command/args — auto-spawns & shares Hub):
   {
     "mcpServers": {
       "figelo": {
         "command": "figelo-mcp",
         "args": ["stdio"]
       }
     }
   }

5) Custom Connector Integration (REST & WebSocket):
   - REST Discovery: GET  http://${host}:${port}/api/tools
   - REST Tool Call: POST ${apiUrl}
     Body: { "tool": "create_frame", "args": { "name": "Card", "width": 320, "height": 200 } }
   - WebSocket Call: ${wsUrl}
     Send: { "type": "call", "id": "req-1", "tool": "get_selection", "args": {} }
`);
}

function printConnectorResults(results: ConnectorActionResult[]): void {
  let anyError = false;
  let needsClaudeDesktopRestart = false;

  for (const res of results) {
    const tag = res.status.toUpperCase().padEnd(12);
    console.log(`[${tag}] ${res.label} -> ${res.configPath}`);
    console.log(`               ${res.message}`);
    if (res.status === 'error') anyError = true;
    if (res.status === 'connected' && res.target === 'claude-desktop') {
      needsClaudeDesktopRestart = true;
    }
  }

  if (needsClaudeDesktopRestart) {
    const trayHint =
      process.platform === 'win32'
        ? 'Quit Claude Desktop from the Windows System Tray (bottom-right icon -> Quit) and reopen it.'
        : 'Fully Quit Claude Desktop (Cmd+Q) and reopen it.';
    console.log(`\nNote for Claude Desktop: ${trayHint}`);
  }

  if (anyError) {
    process.exitCode = 1;
  }
}

function parseConnectorTargetArg(raw: string | undefined): ConnectorTarget | 'all' | null {
  if (!raw || raw.startsWith('-') || raw === 'all') return 'all';
  if ((CONNECTOR_TARGETS as readonly string[]).includes(raw)) {
    return raw as ConnectorTarget;
  }
  return null;
}

function printHelp(): void {
  console.log(`FigeloMCP v${FIGELO_VERSION} — Multi-Client Figma MCP Hub

Usage:
  figelo-mcp [command] [options]

Commands:
  stdio               Run stdio MCP bridge (auto-starts shared Hub daemon if needed) [default]
  start               Start the unified FigeloMCP Hub (HTTP MCP + REST + WS Relay)
    -d, --daemon      Start Hub in background and exit
    --port <port>     Port to bind (default: ${DEFAULT_PORT})
    --host <host>     Host to bind (default: ${DEFAULT_HOST})
  stop                Stop running Hub daemon
  status              Show Hub health, connected Figma documents, and active clients
  connect [target]    Auto-configure MCP in installed AI apps (default: all)
                      Targets: all, ${CONNECTOR_TARGETS.join(', ')}
  disconnect [target] Remove FigeloMCP config from AI apps (default: all)
  install-service     Register Hub to auto-start on login (macOS LaunchAgent / Windows Startup)
  uninstall-service   Remove auto-start registration
  setup               Print copy-paste configs for Claude, Codex, Antigravity, Cursor, Custom Connectors
  help                Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'stdio';
  const port = parseInt(
    parseFlag(args, '--port') ?? process.env.FIGELO_PORT ?? String(DEFAULT_PORT),
    10,
  );
  const host = parseFlag(args, '--host') ?? process.env.FIGELO_HOST ?? DEFAULT_HOST;
  const isDaemon = args.includes('-d') || args.includes('--daemon');

  switch (cmd) {
    case 'stdio': {
      await startStdioBridge();
      return;
    }

    case 'start': {
      if (isDaemon) {
        const existing = await findRunningHub(host, port);
        if (existing) {
          console.log(
            `FigeloMCP Hub already running at http://${existing.host}:${existing.port} (clients: ${existing.health.totalClients}, plugins: ${existing.health.plugins.length})`,
          );
          return;
        }
        const pid = spawnDetachedHub(port, host);
        const ready = await ensureHubRunning(host, port);
        console.log(
          `FigeloMCP Hub started in background (pid=${pid ?? 'detached'}) at http://${ready.host}:${ready.port}`,
        );
        return;
      }

      const runtime = await startHubServer({ port, host, writePidFile: true });
      console.error(
        `[FigeloMCP Hub] listening on http://${runtime.host}:${runtime.port}` +
          ` (MCP: /mcp, REST: /api/call, WS: ws://${runtime.host}:${runtime.port})`,
      );

      const shutdown = async () => {
        console.error('[FigeloMCP Hub] shutting down...');
        await runtime.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }

    case 'stop': {
      const discovery = readDiscoveryFile();
      const running = await findRunningHub(host, port);
      const pid = discovery?.pid;
      if (!running && !pid) {
        console.log('FigeloMCP Hub is not running.');
        return;
      }
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
          console.log(`Stopped FigeloMCP Hub (pid=${pid}).`);
        } catch (err) {
          console.error(
            `Failed to stop Hub pid=${pid}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      } else {
        console.log('Hub is running without a PID file; stop the process manually.');
      }
      return;
    }

    case 'status': {
      const running = await findRunningHub(host, port);
      if (!running) {
        console.log('FigeloMCP Hub: NOT RUNNING');
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(running.health, null, 2));
      return;
    }

    case 'install-service': {
      const result = installService(port, host);
      console.log(result.message);
      if (process.platform === 'win32') {
        const running = await findRunningHub(host, port);
        if (!running) {
          const started = await ensureHubRunning(host, port);
          console.log(`Hub started immediately at http://${started.host}:${started.port}`);
        }
      }
      return;
    }

    case 'uninstall-service': {
      const result = uninstallService();
      console.log(result.message);
      return;
    }

    case 'setup': {
      printSetupGuide(host, port);
      return;
    }

    case 'connect': {
      const target = parseConnectorTargetArg(args[1]);
      if (!target) {
        console.error(
          `Unknown target "${args[1]}". Valid targets: all, ${CONNECTOR_TARGETS.join(', ')}`,
        );
        process.exit(1);
      }
      printConnectorResults(connectApps(target, { port, host }));
      return;
    }

    case 'disconnect': {
      const target = parseConnectorTargetArg(args[1]);
      if (!target) {
        console.error(
          `Unknown target "${args[1]}". Valid targets: all, ${CONNECTOR_TARGETS.join(', ')}`,
        );
        process.exit(1);
      }
      printConnectorResults(disconnectApps(target, { port, host }));
      return;
    }

    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      return;
    }

    default: {
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('[FigeloMCP] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

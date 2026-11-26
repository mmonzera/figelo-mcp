import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCliEntryPath } from '../client/ensure-hub.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/protocol.js';

export const CONNECTOR_TARGETS = [
  'claude-desktop',
  'claude-code',
  'codex',
  'antigravity',
  'cursor',
] as const;

export type ConnectorTarget = (typeof CONNECTOR_TARGETS)[number];
export type ConnectorStatus = 'connected' | 'disconnected' | 'skipped' | 'error';

export interface ConnectorActionResult {
  target: ConnectorTarget;
  label: string;
  configPath: string;
  status: ConnectorStatus;
  message: string;
  needsRestart?: boolean;
}

export interface ConnectorOptions {
  port?: number;
  host?: string;
  serverName?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeBin?: string;
  cliPath?: string;
}

interface ConfigMutationResult {
  ok: boolean;
  skipped?: boolean;
  message: string;
}

const TARGET_LABELS: Record<ConnectorTarget, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves Claude Desktop's active `claude_desktop_config.json` path across OSes,
 * including Windows MSIX v6+ (`Local\Claude-Data\<pkg>`) and legacy MSIX stores.
 */
export function resolveClaudeDesktopConfigPath(
  home = homedir(),
  env = process.env,
  platform = process.platform,
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');

    const claudeDataDir = join(localAppData, 'Claude-Data');
    if (existsSync(claudeDataDir)) {
      try {
        const entries = readdirSync(claudeDataDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidate = join(claudeDataDir, entry.name, 'claude_desktop_config.json');
          if (existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // ignore unreadable directory
      }
    }

    const packagesDir = join(localAppData, 'Packages');
    if (existsSync(packagesDir)) {
      try {
        const entries = readdirSync(packagesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.startsWith('Claude_')) continue;
          const roamingClaude = join(packagesDir, entry.name, 'LocalCache', 'Roaming', 'Claude');
          if (!existsSync(roamingClaude)) continue;
          const candidate = join(roamingClaude, 'claude_desktop_config.json');
          if (existsSync(candidate)) {
            return candidate;
          }
          const inner = readdirSync(roamingClaude);
          const hasOnlyLeftMarker =
            inner.length > 0 && inner.every((name) => name.startsWith('.user-data-left.'));
          if (!hasOnlyLeftMarker) {
            return candidate;
          }
        }
      } catch {
        // ignore unreadable directory
      }
    }

    return join(appData, 'Claude', 'claude_desktop_config.json');
  }

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }

  return join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/**
 * Resolves Antigravity's MCP config file path.
 */
export function resolveAntigravityConfigPath(home = homedir()): string {
  const primary = join(home, '.gemini', 'config', 'mcp_config.json');
  const fallback = join(home, '.gemini', 'antigravity', 'mcp_config.json');
  if (existsSync(primary) || existsSync(dirname(primary))) {
    return primary;
  }
  return fallback;
}

/**
 * Resolves the config file path for any supported MCP client target.
 */
export function resolveTargetConfigPath(
  target: ConnectorTarget,
  options: ConnectorOptions = {},
): string {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  switch (target) {
    case 'claude-desktop':
      return resolveClaudeDesktopConfigPath(home, env, platform);
    case 'claude-code':
      return join(home, '.claude.json');
    case 'codex':
      return join(home, '.codex', 'config.toml');
    case 'antigravity':
      return resolveAntigravityConfigPath(home);
    case 'cursor':
      return join(home, '.cursor', 'mcp.json');
  }
}

/**
 * Safely merges an entry under `mcpServers[serverName]` in a JSON config file,
 * preserving all existing top-level keys and sibling MCP servers.
 */
export function mergeJsonMcpServer(
  configPath: string,
  serverName: string,
  serverConfig: Record<string, unknown>,
  createIfMissing: boolean,
): ConfigMutationResult {
  const fileExists = existsSync(configPath);
  if (!fileExists && !createIfMissing) {
    return { ok: false, skipped: true, message: 'Config file not found' };
  }

  let data: Record<string, unknown> = {};
  if (fileExists) {
    const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          message: `Invalid JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          message: `Expected top-level JSON object in ${configPath}`,
        };
      }
      data = parsed;
    }
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  let mcpServers: Record<string, unknown> = {};
  if (data.mcpServers !== undefined) {
    if (!isPlainObject(data.mcpServers)) {
      return {
        ok: false,
        message: `Expected "mcpServers" to be an object in ${configPath}`,
      };
    }
    mcpServers = data.mcpServers;
  }

  mcpServers[serverName] = serverConfig;
  data.mcpServers = mcpServers;

  writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, message: `Configured "${serverName}" in ${configPath}` };
}

/**
 * Removes `mcpServers[serverName]` from a JSON config file without disturbing other keys.
 */
export function removeJsonMcpServer(
  configPath: string,
  serverName: string,
): ConfigMutationResult {
  if (!existsSync(configPath)) {
    return { ok: false, skipped: true, message: 'Config file not found' };
  }

  const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  if (raw.trim().length === 0) {
    return { ok: false, skipped: true, message: `"${serverName}" not configured` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      message: `Invalid JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return { ok: false, skipped: true, message: `"${serverName}" not configured` };
  }

  if (!(serverName in parsed.mcpServers)) {
    return { ok: false, skipped: true, message: `"${serverName}" not configured` };
  }

  delete parsed.mcpServers[serverName];
  writeFileSync(configPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return { ok: true, message: `Removed "${serverName}" from ${configPath}` };
}

function buildCodexSectionRegex(serverName: string): RegExp {
  const escaped = escapeRegExp(serverName);
  return new RegExp(
    `(?:^|\\r?\\n)[ \\t]*\\[mcp_servers\\.${escaped}\\][ \\t]*(?:\\r?\\n(?![ \\t]*\\[)[^\\r\\n]*)*`,
    'g',
  );
}

/**
 * Inserts or updates a `[mcp_servers.<serverName>]` block in Codex `config.toml`.
 */
export function upsertCodexToml(
  configPath: string,
  serverName: string,
  url: string,
  createIfMissing: boolean,
): ConfigMutationResult {
  const fileExists = existsSync(configPath);
  if (!fileExists && !createIfMissing) {
    return { ok: false, skipped: true, message: 'Config file not found' };
  }

  if (!fileExists) {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const raw = fileExists ? readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '') : '';
  const block = `[mcp_servers.${serverName}]\nurl = "${url}"\n`;
  const sectionRe = buildCodexSectionRegex(serverName);

  let next: string;
  if (sectionRe.test(raw)) {
    sectionRe.lastIndex = 0;
    let replaced = false;
    next = raw.replace(sectionRe, (match) => {
      if (replaced) return '';
      replaced = true;
      const leadingNewline = match.startsWith('\n') || match.startsWith('\r\n') ? '\n' : '';
      return `${leadingNewline}${block.trimEnd()}`;
    });
    if (!next.endsWith('\n')) next += '\n';
  } else if (raw.trim().length === 0) {
    next = block;
  } else {
    const sep = raw.endsWith('\n\n') || raw.endsWith('\r\n\r\n') ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    next = `${raw}${sep}${block}`;
  }

  writeFileSync(configPath, next, 'utf8');
  return { ok: true, message: `Configured [mcp_servers.${serverName}] in ${configPath}` };
}

/**
 * Removes `[mcp_servers.<serverName>]` from Codex `config.toml`.
 */
export function removeCodexToml(
  configPath: string,
  serverName: string,
): ConfigMutationResult {
  if (!existsSync(configPath)) {
    return { ok: false, skipped: true, message: 'Config file not found' };
  }

  const raw = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  const sectionRe = buildCodexSectionRegex(serverName);
  if (!sectionRe.test(raw)) {
    return { ok: false, skipped: true, message: `"${serverName}" not configured` };
  }

  sectionRe.lastIndex = 0;
  let next = raw.replace(sectionRe, '').replace(/^\r?\n+/, '').replace(/\n{3,}/g, '\n\n');
  if (next.length > 0 && !next.endsWith('\n')) {
    next += '\n';
  }

  writeFileSync(configPath, next, 'utf8');
  return { ok: true, message: `Removed [mcp_servers.${serverName}] from ${configPath}` };
}

function isTargetDetected(target: ConnectorTarget, configPath: string): boolean {
  if (existsSync(configPath)) return true;
  if (target === 'claude-code') return false;
  return existsSync(dirname(configPath));
}

function resolveTargets(target: ConnectorTarget | 'all'): ConnectorTarget[] {
  return target === 'all' ? [...CONNECTOR_TARGETS] : [target];
}

/**
 * Connects one or all supported AI desktop/CLI apps to FigeloMCP.
 */
export function connectApps(
  target: ConnectorTarget | 'all' = 'all',
  options: ConnectorOptions = {},
): ConnectorActionResult[] {
  const port = options.port ?? DEFAULT_PORT;
  const rawHost = options.host ?? DEFAULT_HOST;
  const urlHost = rawHost === '127.0.0.1' ? 'localhost' : rawHost;
  const mcpUrl = `http://${urlHost}:${port}/mcp`;
  const serverName = options.serverName ?? 'figelo';
  const nodeBin = options.nodeBin ?? process.execPath;
  const cliPath = options.cliPath ?? resolveCliEntryPath();
  const explicitTarget = target !== 'all';

  return resolveTargets(target).map((item) => {
    const label = TARGET_LABELS[item];
    const configPath = resolveTargetConfigPath(item, options);

    if (!explicitTarget && !isTargetDetected(item, configPath)) {
      return {
        target: item,
        label,
        configPath,
        status: 'skipped',
        message: `${label} not detected on this machine (run "figelo-mcp connect ${item}" to force create).`,
      };
    }

    let mutation: ConfigMutationResult;
    if (item === 'codex') {
      mutation = upsertCodexToml(configPath, serverName, mcpUrl, true);
    } else if (item === 'claude-code') {
      mutation = mergeJsonMcpServer(
        configPath,
        serverName,
        { type: 'http', url: mcpUrl },
        true,
      );
    } else {
      mutation = mergeJsonMcpServer(
        configPath,
        serverName,
        { command: nodeBin, args: [cliPath, 'stdio'] },
        true,
      );
    }

    if (!mutation.ok) {
      return {
        target: item,
        label,
        configPath,
        status: mutation.skipped ? 'skipped' : 'error',
        message: mutation.message,
      };
    }

    return {
      target: item,
      label,
      configPath,
      status: 'connected',
      message: mutation.message,
      needsRestart: item === 'claude-desktop' || item === 'antigravity' || item === 'cursor',
    };
  });
}

/**
 * Disconnects FigeloMCP from one or all supported AI desktop/CLI apps.
 */
export function disconnectApps(
  target: ConnectorTarget | 'all' = 'all',
  options: ConnectorOptions = {},
): ConnectorActionResult[] {
  const serverName = options.serverName ?? 'figelo';

  return resolveTargets(target).map((item) => {
    const label = TARGET_LABELS[item];
    const configPath = resolveTargetConfigPath(item, options);

    const mutation =
      item === 'codex'
        ? removeCodexToml(configPath, serverName)
        : removeJsonMcpServer(configPath, serverName);

    if (!mutation.ok) {
      return {
        target: item,
        label,
        configPath,
        status: mutation.skipped ? 'skipped' : 'error',
        message: mutation.message,
      };
    }

    return {
      target: item,
      label,
      configPath,
      status: 'disconnected',
      message: mutation.message,
      needsRestart: item === 'claude-desktop' || item === 'antigravity' || item === 'cursor',
    };
  });
}

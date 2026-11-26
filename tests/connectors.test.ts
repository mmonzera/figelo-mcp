import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectApps,
  disconnectApps,
  mergeJsonMcpServer,
  removeCodexToml,
  removeJsonMcpServer,
  resolveClaudeDesktopConfigPath,
  upsertCodexToml,
} from '../src/service/connectors.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'figelo-connectors-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FigeloMCP auto-connectors', () => {
  it('mergeJsonMcpServer preserves existing top-level keys and sibling servers', () => {
    const dir = makeTempDir();
    const cfg = join(dir, 'claude_desktop_config.json');
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          coworkUserFilesPath: 'C:\\Users\\Test\\Claude',
          preferences: { sidebarMode: 'chat' },
          mcpServers: {
            other: { command: 'node', args: ['other.js'] },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const res = mergeJsonMcpServer(
      cfg,
      'figelo',
      { command: 'node', args: ['cli.js', 'stdio'] },
      true,
    );
    expect(res.ok).toBe(true);

    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(parsed.coworkUserFilesPath).toBe('C:\\Users\\Test\\Claude');
    expect(parsed.preferences).toEqual({ sidebarMode: 'chat' });
    expect(parsed.mcpServers.other).toEqual({ command: 'node', args: ['other.js'] });
    expect(parsed.mcpServers.figelo).toEqual({ command: 'node', args: ['cli.js', 'stdio'] });
  });

  it('mergeJsonMcpServer handles empty files and rejects malformed JSON without clobbering', () => {
    const dir = makeTempDir();
    const emptyCfg = join(dir, 'empty.json');
    writeFileSync(emptyCfg, '   \n', 'utf8');

    const okRes = mergeJsonMcpServer(emptyCfg, 'figelo', { url: 'http://localhost:3870/mcp' }, true);
    expect(okRes.ok).toBe(true);
    expect(JSON.parse(readFileSync(emptyCfg, 'utf8'))).toEqual({
      mcpServers: { figelo: { url: 'http://localhost:3870/mcp' } },
    });

    const badCfg = join(dir, 'broken.json');
    writeFileSync(badCfg, '{ not valid json', 'utf8');
    const errRes = mergeJsonMcpServer(badCfg, 'figelo', { url: 'http://localhost:3870/mcp' }, true);
    expect(errRes.ok).toBe(false);
    expect(readFileSync(badCfg, 'utf8')).toBe('{ not valid json');
  });

  it('removeJsonMcpServer removes only figelo and preserves other entries', () => {
    const dir = makeTempDir();
    const cfg = join(dir, 'mcp.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        preferences: { theme: 'dark' },
        mcpServers: {
          figelo: { command: 'node', args: ['cli.js', 'stdio'] },
          keepMe: { url: 'http://example.com/mcp' },
        },
      }),
      'utf8',
    );

    const res = removeJsonMcpServer(cfg, 'figelo');
    expect(res.ok).toBe(true);

    const parsed = JSON.parse(readFileSync(cfg, 'utf8'));
    expect(parsed.preferences).toEqual({ theme: 'dark' });
    expect(parsed.mcpServers).toEqual({ keepMe: { url: 'http://example.com/mcp' } });
  });

  it('upsertCodexToml and removeCodexToml manage [mcp_servers.figelo] cleanly', () => {
    const dir = makeTempDir();
    const tomlPath = join(dir, 'config.toml');
    writeFileSync(
      tomlPath,
      'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://localhost:9000/mcp"\n',
      'utf8',
    );

    const insertRes = upsertCodexToml(tomlPath, 'figelo', 'http://localhost:3870/mcp', true);
    expect(insertRes.ok).toBe(true);
    let content = readFileSync(tomlPath, 'utf8');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).toContain('[mcp_servers.figelo]\nurl = "http://localhost:3870/mcp"');

    const updateRes = upsertCodexToml(tomlPath, 'figelo', 'http://localhost:3871/mcp', true);
    expect(updateRes.ok).toBe(true);
    content = readFileSync(tomlPath, 'utf8');
    expect(content).toContain('url = "http://localhost:3871/mcp"');
    expect(content.match(/\[mcp_servers\.figelo\]/g)?.length).toBe(1);

    const removeRes = removeCodexToml(tomlPath, 'figelo');
    expect(removeRes.ok).toBe(true);
    content = readFileSync(tomlPath, 'utf8');
    expect(content).not.toContain('[mcp_servers.figelo]');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).toContain('model = "gpt-5"');
  });

  it('detects Windows Claude-Data MSIX v6 config path before legacy Packages', () => {
    const dir = makeTempDir();
    const localAppData = join(dir, 'AppData', 'Local');
    const appData = join(dir, 'AppData', 'Roaming');

    const msixDataCfg = join(localAppData, 'Claude-Data', 'claude_abc123', 'claude_desktop_config.json');
    mkdirSync(join(localAppData, 'Claude-Data', 'claude_abc123'), { recursive: true });
    writeFileSync(msixDataCfg, '{}', 'utf8');

    const legacyDir = join(localAppData, 'Packages', 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, '.user-data-left.claude_abc123'), '', 'utf8');

    const resolved = resolveClaudeDesktopConfigPath(
      dir,
      { LOCALAPPDATA: localAppData, APPDATA: appData },
      'win32',
    );
    expect(resolved).toBe(msixDataCfg);
  });

  it('connectApps("all") connects detected apps, skips absent ones, and disconnectApps removes them', () => {
    const home = makeTempDir();
    const localAppData = join(home, 'AppData', 'Local');
    const appData = join(home, 'AppData', 'Roaming');

    const claudeCfg = join(localAppData, 'Claude-Data', 'claude_xyz', 'claude_desktop_config.json');
    mkdirSync(join(localAppData, 'Claude-Data', 'claude_xyz'), { recursive: true });
    writeFileSync(claudeCfg, JSON.stringify({ preferences: { ok: true } }), 'utf8');

    const claudeCodeCfg = join(home, '.claude.json');
    writeFileSync(claudeCodeCfg, JSON.stringify({ projects: {} }), 'utf8');

    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });

    const opts = {
      homeDir: home,
      env: { LOCALAPPDATA: localAppData, APPDATA: appData },
      platform: 'win32' as NodeJS.Platform,
      nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\FigeloMCP\\dist\\cli.js',
    };

    const results = connectApps('all', opts);
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r]));
    expect(byTarget['claude-desktop'].status).toBe('connected');
    expect(byTarget['claude-code'].status).toBe('connected');
    expect(byTarget.codex.status).toBe('connected');
    expect(byTarget.antigravity.status).toBe('connected');
    expect(byTarget.cursor.status).toBe('skipped');
    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(false);

    const disconnected = disconnectApps('all', opts);
    const disByTarget = Object.fromEntries(disconnected.map((r) => [r.target, r]));
    expect(disByTarget['claude-desktop'].status).toBe('disconnected');
    expect(disByTarget['claude-code'].status).toBe('disconnected');
    expect(disByTarget.codex.status).toBe('disconnected');
    expect(disByTarget.antigravity.status).toBe('disconnected');
  });
});

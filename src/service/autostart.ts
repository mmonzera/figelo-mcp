import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliEntryPath } from '../client/ensure-hub.js';
import { DEFAULT_HOST, DEFAULT_PORT } from '../shared/protocol.js';

export interface ServiceResult {
  platform: NodeJS.Platform;
  servicePath: string;
  message: string;
}

function getMacPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', 'com.figelomcp.hub.plist');
}

function getWindowsStartupVbsPath(): string {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'FigeloMCP-Hub.vbs',
  );
}

function getLinuxSystemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'figelo-mcp.service');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function installService(
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
): ServiceResult {
  const nodeBin = process.execPath;
  const cliPath = resolveCliEntryPath();
  const logDir = join(homedir(), '.figelo-mcp');
  mkdirSync(logDir, { recursive: true });

  if (process.platform === 'darwin') {
    const plistPath = getMacPlistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.figelomcp.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeBin)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>start</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--host</string>
    <string>${escapeXml(host)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDir, 'hub.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDir, 'hub.err.log'))}</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist, 'utf8');
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    } catch {
      // ignore if not loaded yet
    }
    execFileSync('launchctl', ['load', '-w', plistPath], { stdio: 'inherit' });

    return {
      platform: 'darwin',
      servicePath: plistPath,
      message: `Installed and started macOS LaunchAgent at ${plistPath}`,
    };
  }

  if (process.platform === 'win32') {
    const vbsPath = getWindowsStartupVbsPath();
    mkdirSync(
      join(vbsPath, '..'),
      { recursive: true },
    );
    const cmd = `""${nodeBin}" "${cliPath}" start --port ${port} --host ${host}"`;
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run "${cmd.replace(/"/g, '""')}", 0, False`,
      '',
    ].join('\r\n');
    // Simpler unambiguous VBScript quoting: chr(34) = "
    const safeVbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `cmd = Chr(34) & "${nodeBin}" & Chr(34) & " " & Chr(34) & "${cliPath}" & Chr(34) & " start --port ${port} --host ${host}"`,
      'WshShell.Run cmd, 0, False',
      '',
    ].join('\r\n');
    void vbs;
    writeFileSync(vbsPath, safeVbs, 'utf8');

    return {
      platform: 'win32',
      servicePath: vbsPath,
      message: `Installed Windows Startup launcher at ${vbsPath} (runs silently on login).`,
    };
  }

  // Linux systemd user service fallback
  const unitPath = getLinuxSystemdUnitPath();
  mkdirSync(join(unitPath, '..'), { recursive: true });
  const unit = `[Unit]
Description=FigeloMCP Unified Figma Hub
After=network.target

[Service]
ExecStart="${nodeBin}" "${cliPath}" start --port ${port} --host ${host}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit, 'utf8');
  return {
    platform: process.platform,
    servicePath: unitPath,
    message: `Created systemd user unit at ${unitPath}. Run: systemctl --user enable --now figelo-mcp`,
  };
}

export function uninstallService(): ServiceResult {
  if (process.platform === 'darwin') {
    const plistPath = getMacPlistPath();
    if (existsSync(plistPath)) {
      try {
        execFileSync('launchctl', ['unload', '-w', plistPath], { stdio: 'ignore' });
      } catch {
        // ignore
      }
      unlinkSync(plistPath);
    }
    return {
      platform: 'darwin',
      servicePath: plistPath,
      message: `Removed macOS LaunchAgent at ${plistPath}`,
    };
  }

  if (process.platform === 'win32') {
    const vbsPath = getWindowsStartupVbsPath();
    if (existsSync(vbsPath)) {
      unlinkSync(vbsPath);
    }
    return {
      platform: 'win32',
      servicePath: vbsPath,
      message: `Removed Windows Startup launcher at ${vbsPath}`,
    };
  }

  const unitPath = getLinuxSystemdUnitPath();
  if (existsSync(unitPath)) {
    unlinkSync(unitPath);
  }
  return {
    platform: process.platform,
    servicePath: unitPath,
    message: `Removed systemd user unit at ${unitPath}`,
  };
}

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  DEFAULT_TIMEOUT_MS,
  type HubStatusPushMessage,
  type PluginErrorMessage,
  type PluginMetadata,
  type PluginProgressMessage,
  type PluginResponseMessage,
} from '../shared/protocol.js';

export interface PluginConnection {
  ws: WebSocket;
  meta: PluginMetadata;
}

interface PendingCall {
  id: string;
  channel: string;
  method: string;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class PluginBroker {
  private plugins = new Map<string, PluginConnection>();
  private activeChannel: string | null = null;
  private pending = new Map<string, PendingCall>();
  private mcpSessionCount = 0;
  private wsClientCount = 0;
  private stats = {
    totalRequests: 0,
    totalSuccess: 0,
    totalErrors: 0,
    totalTimeouts: 0,
  };

  registerPlugin(
    ws: WebSocket,
    info: {
      channel: string;
      documentName: string;
      fileKey?: string | null;
      currentPage?: string;
      pluginVersion?: string;
    },
  ): PluginMetadata {
    const channel = info.channel.trim() || 'default';
    const existing = this.plugins.get(channel);
    if (existing && existing.ws !== ws) {
      try {
        existing.ws.close(4000, 'Replaced by newer connection on same document channel');
      } catch {
        // ignore close errors
      }
    }

    const meta: PluginMetadata = {
      channel,
      documentName: info.documentName || 'Untitled',
      fileKey: info.fileKey ?? null,
      currentPage: info.currentPage || 'Page 1',
      pluginVersion: info.pluginVersion || '0.1.0',
      connectedAt: new Date().toISOString(),
    };

    this.plugins.set(channel, { ws, meta });
    this.activeChannel = channel;
    this.notifyPluginsStatus();
    return meta;
  }

  unregisterPluginBySocket(ws: WebSocket): string | null {
    for (const [channel, conn] of this.plugins.entries()) {
      if (conn.ws === ws) {
        this.plugins.delete(channel);
        if (this.activeChannel === channel) {
          const next = this.plugins.keys().next();
          this.activeChannel = next.done ? null : next.value;
        }
        // Reject pending calls targeting this disconnected plugin
        for (const [id, call] of this.pending.entries()) {
          if (call.channel === channel) {
            clearTimeout(call.timer);
            this.pending.delete(id);
            call.reject(new Error(`Figma plugin disconnected on channel "${channel}"`));
          }
        }
        this.notifyPluginsStatus();
        return channel;
      }
    }
    return null;
  }

  listPlugins(): PluginMetadata[] {
    return Array.from(this.plugins.values()).map((c) => c.meta);
  }

  getActiveChannel(): string | null {
    return this.activeChannel;
  }

  setClientCounts(counts: { mcpSessions?: number; wsClients?: number }): void {
    if (typeof counts.mcpSessions === 'number') {
      this.mcpSessionCount = counts.mcpSessions;
    }
    if (typeof counts.wsClients === 'number') {
      this.wsClientCount = counts.wsClients;
    }
    this.notifyPluginsStatus();
  }

  getStatusSnapshot() {
    return {
      activeChannel: this.activeChannel,
      plugins: this.listPlugins(),
      pendingRequests: this.pending.size,
      mcpSessions: this.mcpSessionCount,
      wsClients: this.wsClientCount,
      totalClients: this.mcpSessionCount + this.wsClientCount,
      stats: { ...this.stats },
    };
  }

  notifyPluginsStatus(): void {
    const payload: HubStatusPushMessage = {
      type: 'hub_status',
      activeClients: this.mcpSessionCount + this.wsClientCount,
      connectedPlugins: this.plugins.size,
    };
    const encoded = JSON.stringify(payload);
    for (const conn of this.plugins.values()) {
      if (conn.ws.readyState === 1) {
        try {
          conn.ws.send(encoded);
        } catch {
          // ignore transient write errors
        }
      }
    }
  }

  private resolveTarget(requestedChannel?: string): PluginConnection {
    if (this.plugins.size === 0) {
      throw new Error(
        'No Figma document connected. Open the FigeloMCP plugin inside Figma Desktop first.',
      );
    }

    if (requestedChannel) {
      const exact = this.plugins.get(requestedChannel);
      if (exact) return exact;

      // Also allow matching by fileKey or documentName for convenience
      for (const conn of this.plugins.values()) {
        if (
          conn.meta.fileKey === requestedChannel ||
          conn.meta.documentName.toLowerCase() === requestedChannel.toLowerCase()
        ) {
          return conn;
        }
      }

      const available = this.listPlugins()
        .map((p) => `${p.channel} ("${p.documentName}")`)
        .join(', ');
      throw new Error(
        `Figma channel "${requestedChannel}" not found. Connected: ${available}`,
      );
    }

    if (this.activeChannel) {
      const active = this.plugins.get(this.activeChannel);
      if (active) return active;
    }

    const first = this.plugins.values().next().value;
    if (!first) {
      throw new Error('No Figma document connected.');
    }
    return first;
  }

  async callPlugin(
    method: string,
    params: Record<string, unknown> = {},
    options: { channel?: string; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const target = this.resolveTarget(options.channel);
    if (target.ws.readyState !== 1) {
      throw new Error(`Figma plugin socket on channel "${target.meta.channel}" is not open`);
    }

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.stats.totalRequests++;

    return new Promise<unknown>((resolve, reject) => {
      const createTimer = () =>
        setTimeout(() => {
          this.pending.delete(id);
          this.stats.totalTimeouts++;
          reject(
            new Error(
              `Request "${method}" on channel "${target.meta.channel}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);

      const pendingCall: PendingCall = {
        id,
        channel: target.meta.channel,
        method,
        timeoutMs,
        timer: createTimer(),
        resolve: (value: unknown) => {
          this.stats.totalSuccess++;
          resolve(value);
        },
        reject: (err: Error) => {
          this.stats.totalErrors++;
          reject(err);
        },
      };

      this.pending.set(id, pendingCall);

      try {
        target.ws.send(
          JSON.stringify({
            type: 'request',
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        clearTimeout(pendingCall.timer);
        this.pending.delete(id);
        const error = err instanceof Error ? err : new Error(String(err));
        pendingCall.reject(error);
      }
    });
  }

  handlePluginMessage(
    msg: PluginResponseMessage | PluginErrorMessage | PluginProgressMessage,
  ): boolean {
    const call = this.pending.get(msg.id);
    if (!call) return false;

    if (msg.type === 'progress') {
      clearTimeout(call.timer);
      call.timer = setTimeout(() => {
        this.pending.delete(call.id);
        this.stats.totalTimeouts++;
        call.reject(
          new Error(
            `Request "${call.method}" on channel "${call.channel}" timed out after ${call.timeoutMs}ms`,
          ),
        );
      }, call.timeoutMs);
      return true;
    }

    clearTimeout(call.timer);
    this.pending.delete(msg.id);

    if (msg.type === 'response') {
      call.resolve(msg.result);
    } else {
      const code = msg.error?.code || 'PLUGIN_ERROR';
      const message = msg.error?.message || 'Unknown Figma plugin error';
      call.reject(new Error(`${code}: ${message}`));
    }
    return true;
  }

  rejectAllPending(reason: string): void {
    for (const [id, call] of this.pending.entries()) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(new Error(reason));
    }
  }
}

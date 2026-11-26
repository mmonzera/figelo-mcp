/**
 * FigeloMCP Shared Wire Protocol & Constants
 *
 * Defines all message types exchanged between:
 * - FigeloMCP Hub <-> Figma Plugin UI WebSocket
 * - FigeloMCP Hub <-> Direct WebSocket Clients (Atelier, t3code, etc.)
 * - FigeloMCP Hub <-> REST API Clients
 */

export const FIGELO_VERSION = '0.1.0';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3870;
export const PORT_RANGE = [3870, 3871, 3872, 3873, 3874, 3875] as const;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 25_000;

export interface PluginMetadata {
  channel: string;
  documentName: string;
  fileKey: string | null;
  currentPage: string;
  pluginVersion: string;
  connectedAt: string;
}

/** Sent by Figma Plugin UI immediately after WebSocket opens. */
export interface PluginHelloMessage {
  type: 'plugin_hello';
  channel: string;
  documentName: string;
  fileKey?: string | null;
  currentPage?: string;
  pluginVersion?: string;
}

/** Sent by Hub to a specific Figma Plugin to execute a handler. */
export interface PluginRequestMessage {
  type: 'request';
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** Sent by Figma Plugin back to Hub on success. */
export interface PluginResponseMessage {
  type: 'response';
  id: string;
  result: unknown;
}

/** Sent by Figma Plugin back to Hub on handler failure. */
export interface PluginErrorMessage {
  type: 'error';
  id: string;
  error: {
    code: string;
    message: string;
  };
}

/** Sent by Figma Plugin while executing a long-running task to extend timeout. */
export interface PluginProgressMessage {
  type: 'progress';
  id: string;
  message?: string;
}

/** Sent by Hub to connected Figma Plugins so UI can show active AI client count. */
export interface HubStatusPushMessage {
  type: 'hub_status';
  activeClients: number;
  connectedPlugins: number;
}

/** Direct WS client call message (for harnesses like Atelier / t3code). */
export interface WsClientHelloMessage {
  type: 'client_hello';
  clientName?: string;
}

export interface WsClientCallMessage {
  type: 'call';
  id: string;
  tool: string;
  args?: Record<string, unknown>;
  channel?: string;
}

export interface WsClientResultMessage {
  type: 'result';
  id: string;
  ok: true;
  result: unknown;
}

export interface WsClientErrorMessage {
  type: 'result_error';
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export interface PingMessage {
  type: 'ping';
  ts?: number;
}

export interface PongMessage {
  type: 'pong';
  ts?: number;
}

export type WireMessage =
  | PluginHelloMessage
  | PluginRequestMessage
  | PluginResponseMessage
  | PluginErrorMessage
  | PluginProgressMessage
  | HubStatusPushMessage
  | WsClientHelloMessage
  | WsClientCallMessage
  | WsClientResultMessage
  | WsClientErrorMessage
  | PingMessage
  | PongMessage;

export interface HubDiscoveryInfo {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  version: string;
}

export interface ToolJsonSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

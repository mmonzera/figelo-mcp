export * from './shared/protocol.js';
export * from './shared/design-helpers.js';
export { PluginBroker, type PluginConnection } from './hub/plugin-broker.js';
export {
  FIGELO_MCP_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  createFigeloMcpServer,
  executeToolWithBroker,
  getToolsJsonSchemas,
  type ToolDefinition,
  type ToolExecutor,
} from './hub/mcp-tools.js';
export {
  startHubServer,
  readDiscoveryFile,
  FIGELO_STATE_DIR,
  FIGELO_HUB_FILE,
  type HubRuntime,
  type StartHubOptions,
} from './hub/server.js';
export { ensureHubRunning, probeHubHealth, type HubHealthResponse } from './client/ensure-hub.js';
export { startStdioBridge } from './client/hub-client.js';
export { installService, uninstallService } from './service/autostart.js';

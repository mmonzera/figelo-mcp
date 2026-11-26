# FigeloMCP

**One Figma plugin. One local Hub. Connect Antigravity, Claude Code, Codex, Cursor, t3code, and your own harnesses (like Atelier) to Figma simultaneously — with zero connection contention.**

Most Figma MCP bridges spawn a separate relay inside each IDE and evict existing connections (`4001: Replaced by new mcp`) whenever a second app connects. **FigeloMCP** fixes this at the architecture level with a unified Hub daemon and unicast request routing.

---

## Architecture

```text
Antigravity  ──┐
Claude Code  ──┼── Streamable HTTP (/mcp) ──┐
Codex        ──┘                            │
                                            ▼
Atelier      ──── REST (/api/call) ────▶ [ FigeloMCP Hub (:3870) ] ◀──WS──▶ [ FigeloMCP Figma Plugin ]
                                            ▲                                  (Serial Task Queue)
t3code / CLI ──── WS or Stdio Bridge ───────┘
```

### Why it never fights over connections
- **Single Shared Hub Daemon**: Runs independently on `127.0.0.1:3870` (fallback `3870–3875`). Closing one IDE never disconnects your other apps or Figma.
- **Zero Evictions**: Every MCP client gets its own isolated `McpServer` session sharing one `PluginBroker`.
- **Unicast Routing**: Each `requestId` is tracked back to its exact caller — no broadcast leaks across apps.
- **Multi-Document Support**: Open multiple Figma files at once; target any document via its `channel` (use `list_figma_documents`).
- **Serial Sandbox Queue**: Inside Figma, mutations execute sequentially in an async queue so concurrent writes from 5+ AI agents never corrupt nodes.
- **Cross-Platform**: Works out of the box on **macOS** (`LaunchAgents`) and **Windows** (`Startup` silent launcher).

---

## Quick Start (macOS & Windows)

### 1. Install & Build

```bash
git clone <your-figelo-mcp-repo-url> FigeloMCP
cd FigeloMCP
npm install
npm run build
```

*(Optional)* Link globally so `figelo-mcp` works anywhere on your machine:

```bash
npm link
```

### 2. Start the Hub (Once)

Start in background right now:

```bash
figelo-mcp start -d
```

Or install auto-start on login (macOS LaunchAgent / Windows silent Startup script):

```bash
figelo-mcp install-service
```

Check status anytime:

```bash
figelo-mcp status
```

### 3. Load the Plugin in Figma Desktop

1. Open **Figma Desktop** → **Plugins** → **Development** → **Import plugin from manifest...**
2. Select `FigeloMCP/plugin/manifest.json`
3. Run **Plugins → Development → FigeloMCP**

The plugin automatically finds the Hub on `3870–3875` and displays connected AI clients in real time.

---

## Connecting Your Apps & Harnesses

Run `figelo-mcp setup` anytime to print these configs.

### Option 1: Streamable HTTP MCP (Recommended — zero extra processes)

Works with any client supporting Streamable HTTP MCP (`Claude Code`, `Antigravity`, `Cursor`, `Codex`, etc.):

```json
{
  "mcpServers": {
    "figelo": {
      "url": "http://127.0.0.1:3870/mcp"
    }
  }
}
```

### Option 2: Stdio MCP (For clients that only support `command` + `args`)

If a client doesn't support HTTP MCP yet, use stdio mode. It automatically detects (or detached-spawns) the shared Hub and forwards calls over HTTP so it still never fights other apps:

```json
{
  "mcpServers": {
    "figelo": {
      "command": "figelo-mcp",
      "args": ["stdio"]
    }
  }
}
```

*(Or without `npm link`: `"command": "node"`, `"args": ["/absolute/path/to/FigeloMCP/dist/cli.js", "stdio"]`)*

### Option 3: Custom Harnesses (Atelier, t3code, scripts)

#### REST API (Simplest for custom agent harnesses)

- **Discover all tool schemas**: `GET http://127.0.0.1:3870/api/tools`
- **Execute any tool**: `POST http://127.0.0.1:3870/api/call`

```ts
const res = await fetch('http://127.0.0.1:3870/api/call', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tool: 'create_frame',
    args: {
      name: 'Atelier Card',
      width: 360,
      height: 220,
      fillHex: '#FFFFFF',
      cornerRadius: 16,
      layoutMode: 'VERTICAL',
      itemSpacing: 12,
      paddingTop: 16,
      paddingRight: 16,
      paddingBottom: 16,
      paddingLeft: 16
    }
  })
});
const data = await res.json();
```

#### Direct WebSocket

Connect to `ws://127.0.0.1:3870`:

```json
{ "type": "client_hello", "clientName": "atelier" }
{ "type": "call", "id": "req-1", "tool": "get_selection", "args": {} }
```

---

## Available Tools

- **Multi-doc & Health**: `list_figma_documents`, `ping`
- **Inspect**: `get_document_info`, `get_pages`, `set_current_page`, `get_selection`, `set_selection`, `get_node`, `find_nodes`, `get_styles`, `get_variables`
- **Create**: `create_frame`, `create_text`, `create_rectangle`, `create_ellipse`, `create_svg`, `create_component`, `create_instance`
- **Modify & Export**: `update_node`, `set_auto_layout`, `delete_nodes`, `export_image`
- **Full Escape Hatch**: `execute_figma_js` (run arbitrary async Figma Plugin API scripts)

---

## CLI Commands

| Command | Description |
| --- | --- |
| `figelo-mcp start [-d]` | Start the unified Hub (`-d` runs detached in background) |
| `figelo-mcp stop` | Stop the running Hub daemon |
| `figelo-mcp status` | Print Hub health, connected Figma docs, and active clients |
| `figelo-mcp stdio` | Run stdio MCP bridge connected to the shared Hub |
| `figelo-mcp install-service` | Auto-start Hub on login (macOS LaunchAgent / Windows Startup) |
| `figelo-mcp uninstall-service` | Remove auto-start registration |
| `figelo-mcp setup` | Print ready-to-paste config snippets |

---

## Development

```bash
npm run typecheck
npm run build
npm test
```

## License

MIT

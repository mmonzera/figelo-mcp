# FigeloMCP

**One Figma plugin. One local Hub. Connect Claude Code, Codex, Antigravity, Cursor, and any Custom Connector to Figma simultaneously — with zero connection contention.**

[English](#english) | [Bahasa Indonesia](#bahasa-indonesia)

---

<a id="english"></a>

## English

Most Figma MCP bridges spawn a separate relay inside each IDE and evict existing connections (`4001: Replaced by new mcp`) whenever a second app connects. **FigeloMCP** fixes this at the architecture level with a unified Hub daemon and unicast request routing.

### Architecture

```text
Claude Code      ──┐
Codex            ──┼── Streamable HTTP (/mcp) ──┐
Antigravity      ──┤                            │
Cursor           ──┘                            ▼
                                         [ FigeloMCP Hub (:3870) ] ◀──WS──▶ [ FigeloMCP Figma Plugin ]
Custom Connector ── REST (/api/call) ───────────▲                              (Serial Task Queue)
                 └─ WS / Stdio Bridge ──────────┘
```

#### Why it never fights over connections
- **Single Shared Hub Daemon**: Runs independently on `127.0.0.1:3870` (fallback `3870–3875`). Closing one app never disconnects your other apps or Figma.
- **Zero Evictions**: Every MCP client gets its own isolated `McpServer` session sharing one `PluginBroker`.
- **Unicast Routing**: Each `requestId` is tracked back to its exact caller — no broadcast leaks across apps.
- **Multi-Document Support**: Open multiple Figma files at once; target any document via its `channel` (use `list_figma_documents`).
- **Serial Sandbox Queue**: Inside Figma, mutations execute sequentially in an async queue so concurrent writes from multiple AI agents never corrupt nodes.
- **Cross-Platform**: Works out of the box on **macOS** (`LaunchAgents`) and **Windows** (`Startup` silent launcher).

---

### Quick Start (Windows & macOS)

#### 1. Install & Build

```bash
git clone https://github.com/mmonzera/figelo-mcp.git FigeloMCP
cd FigeloMCP
npm install
npm run build
```

Link globally so `figelo-mcp` works anywhere on your machine:

```bash
npm link
```

> **Windows PowerShell note:** If `npm link` or `figelo-mcp` fails with `running scripts is disabled on this system`, run this once in PowerShell (no admin required):
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

#### 2. Start the Hub

Start in background right now:

```bash
figelo-mcp start -d
```

Or register auto-start on login (macOS LaunchAgent / Windows Startup):

```bash
figelo-mcp install-service
```

Check status anytime:

```bash
figelo-mcp status
```

#### 3. Load the Plugin in Figma Desktop

1. Open **Figma Desktop** → **Plugins** → **Development** → **Import plugin from manifest...**
2. Select `FigeloMCP/plugin/manifest.json`
3. Run **Plugins → Development → FigeloMCP**

Keep the plugin window open while working. It automatically connects to the Hub on `localhost:3870–3875` and shows **Connected** along with active AI clients.

---

### Connecting Your Apps & Custom Connectors

#### Option A: One-Command Auto-Connect (Recommended)

Automatically detect and configure all supported desktop & CLI apps installed on your machine (**Claude Desktop**, **Claude Code**, **Codex**, **Antigravity**, and **Cursor**):

```bash
figelo-mcp connect
```

Or connect/disconnect a specific target (`all`, `claude-desktop`, `claude-code`, `codex`, `antigravity`, `cursor`):

```bash
figelo-mcp connect claude-desktop
figelo-mcp disconnect claude-desktop
```

> **Windows Claude Desktop note:** On Windows (MSIX v6+), Claude Desktop stores its config under `%LOCALAPPDATA%\Claude-Data\<package>\claude_desktop_config.json`, which `figelo-mcp connect` detects automatically. Because **System tray** keeps Claude running in the background, **right-click the Claude icon in the Windows System Tray → Quit**, then reopen Claude Desktop so it loads `figelo`.

#### Option B: Manual / Custom Connectors

All apps below can connect **at the same time** to the same Hub. Run `figelo-mcp setup` anytime to print quick snippets.

##### 1. Claude Code

```bash
claude mcp add --scope user --transport http figelo http://localhost:3870/mcp
```

*(Omit `--scope user` if you only want it in the current project.)*

#### 2. Codex (OpenAI Codex CLI)

```bash
codex mcp add figelo --url http://localhost:3870/mcp
```

Or add to `~/.codex/config.toml`:

```toml
[mcp_servers.figelo]
url = "http://localhost:3870/mcp"
```

#### 3. Antigravity, Cursor, and JSON `mcpServers` Clients

Add to your app's MCP configuration:

```json
{
  "mcpServers": {
    "figelo": {
      "url": "http://localhost:3870/mcp"
    }
  }
}
```

#### 4. Custom Connector

Depending on what your custom connector supports:

- **Streamable HTTP MCP (Recommended):**
  - Connection type: **HTTP** (Streamable HTTP URL)
  - Server name: `figelo-mcp`
  - Endpoint URL: `http://localhost:3870/mcp`
- **Stdio MCP (Local command):**
  - Command: `figelo-mcp`
  - Args: `["stdio"]`
  *(Or without `npm link`: `"command": "node"`, `"args": ["/absolute/path/to/FigeloMCP/dist/cli.js", "stdio"]`)*
- **REST API:**
  - Discover all tool schemas: `GET http://127.0.0.1:3870/api/tools`
  - Execute any tool: `POST http://127.0.0.1:3870/api/call`
    ```ts
    const res = await fetch('http://127.0.0.1:3870/api/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'create_frame',
        args: {
          name: 'Card',
          width: 360,
          height: 220,
          fillHex: '#FFFFFF',
          cornerRadius: 16
        }
      })
    });
    const data = await res.json();
    ```
- **Direct WebSocket (`ws://127.0.0.1:3870`):**
  ```json
  { "type": "client_hello", "clientName": "custom-client" }
  { "type": "call", "id": "req-1", "tool": "get_selection", "args": {} }
  ```

### Use Cases & Edge Cases (Troubleshooting)

- **Multi-Client Simultaneously**: Open **1 Hub + 1 Figma plugin** and connect Claude Code, Codex, Antigravity, Cursor, and a Custom Connector at the same time — no `4001: Replaced by new mcp` eviction.
- **Claude Code vs. Claude Desktop (`+ → Plugins` menu)**:
  - `claude mcp add ...` writes to `~/.claude.json` (used by Claude Code CLI and the Code tab). It **will not** appear inside Claude Desktop's `+ → Plugins` menu even when `claude mcp list` already shows `figelo ... √ Connected` — just ask Claude directly in the Code tab or CLI.
  - To use FigeloMCP in Claude Desktop's **Chat** tab, run `figelo-mcp connect claude-desktop` (or `figelo-mcp connect`). It automatically finds `%LOCALAPPDATA%\Claude-Data\<package>\claude_desktop_config.json` (Windows MSIX) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) and configures the `stdio` bridge safely without overwriting your preferences. Remember to **Quit from the System Tray** (Windows) / **Cmd+Q** (macOS) and reopen Claude Desktop.
- **Custom Connector not showing tools in an active chat**:
  - Verify the HTTP URL ends with `/mcp` (`http://localhost:3870/mcp`), not `/mc`.
  - Start a **new chat session** (or restart the active agent session) so newly added MCP tools are loaded.
  - Some clients require explicitly mentioning the connector (e.g., `@figelo-mcp`) or enabling it in the workspace/connector toggle.
- **Sharing a `figma.com/design/...` link**:
  - FigeloMCP interacts with the document currently **open in Figma Desktop** where the FigeloMCP plugin is running (it does not fetch files from the Figma cloud URL). Open the target file in Figma Desktop and keep the plugin window open.
- **Windows PowerShell `ExecutionPolicy` error (`npm.ps1 cannot be loaded`)**:
  - Run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once in PowerShell (no admin needed), or use `npm.cmd link` / `node dist/cli.js start -d`.
- **Figma Manifest `allowedDomains` validation**:
  - Figma Desktop rejects IP literals like `ws://127.0.0.1:3870` in `manifest.json` (`must be a valid URL`). Always use `ws://localhost:3870–3875` in `plugin/manifest.json`.

---

<a id="bahasa-indonesia"></a>

## Bahasa Indonesia

**Satu plugin Figma. Satu Hub lokal. Hubungkan Claude Code, Codex, Antigravity, Cursor, maupun Custom Connector ke Figma secara bersamaan — tanpa saling memutus koneksi.**

Kebanyakan bridge MCP Figma menjalankan relay terpisah di tiap aplikasi dan memutus koneksi yang sudah ada (`4001: Replaced by new mcp`) saat aplikasi kedua terhubung. **FigeloMCP** menyelesaikan masalah ini dengan satu Hub daemon bersama dan routing request unicast.

### Cara Instalasi & Setup (Windows & macOS)

#### 1. Clone, Build, dan Link

```bash
git clone https://github.com/mmonzera/figelo-mcp.git FigeloMCP
cd FigeloMCP
npm install
npm run build
npm link
```

> **Catatan Windows PowerShell:** Jika `npm link` atau `figelo-mcp` gagal dengan error `running scripts is disabled on this system`, jalankan perintah ini sekali saja di PowerShell (tidak perlu Run as Administrator):
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

#### 2. Jalankan FigeloMCP Hub

Jalankan Hub di background sekarang:

```bash
figelo-mcp start -d
```

*(Opsional)* Daftarkan auto-start agar Hub otomatis menyala setiap login Windows / macOS:

```bash
figelo-mcp install-service
```

Cek status Hub kapan saja:

```bash
figelo-mcp status
```

#### 3. Pasang Plugin di Figma Desktop

1. Buka **Figma Desktop** → **Plugins** → **Development** → **Import plugin from manifest...**
2. Pilih file `FigeloMCP/plugin/manifest.json`
3. Jalankan **Plugins → Development → FigeloMCP**

Biarkan jendela plugin **FigeloMCP** tetap terbuka selama bekerja. Statusnya akan berubah menjadi **Connected** di port `:3870`.

---

### Cara Menghubungkan ke Claude Desktop, Claude Code, Codex, Antigravity, atau Custom Connector

#### Opsi A: Auto-Connect 1 Perintah (Direkomendasikan)

Deteksi dan pasang FigeloMCP secara otomatis ke semua aplikasi yang terpasang di komputer Anda (**Claude Desktop**, **Claude Code**, **Codex**, **Antigravity**, dan **Cursor**):

```bash
figelo-mcp connect
```

Atau pilih satu target saja (`all`, `claude-desktop`, `claude-code`, `codex`, `antigravity`, `cursor`):

```bash
figelo-mcp connect claude-desktop
figelo-mcp disconnect claude-desktop
```

> **Catatan Claude Desktop di Windows:** Pada versi MSIX v6+, Claude Desktop menyimpan konfigurasinya di `%LOCALAPPDATA%\Claude-Data\<package>\claude_desktop_config.json` (otomatis terdeteksi oleh `figelo-mcp connect`). Karena **System tray** membuat Claude tetap jalan di background saat jendela ditutup, **klik kanan ikon Claude di Windows System Tray → Quit**, lalu buka ulang Claude Desktop agar `figelo` termuat.

#### Opsi B: Manual / Custom Connector

Semua aplikasi berikut bisa terhubung **bersamaan** ke satu Hub dan satu plugin Figma yang sama:

##### 1. Claude Code

```bash
claude mcp add --scope user --transport http figelo http://localhost:3870/mcp
```

*(Hapus `--scope user` jika hanya ingin dipasang di project saat ini.)*

#### 2. Codex (OpenAI Codex CLI)

```bash
codex mcp add figelo --url http://localhost:3870/mcp
```

Atau tambahkan ke `~/.codex/config.toml`:

```toml
[mcp_servers.figelo]
url = "http://localhost:3870/mcp"
```

#### 3. Antigravity, Cursor, dan Client MCP JSON

Tambahkan ke konfigurasi `mcpServers` di aplikasi Anda:

```json
{
  "mcpServers": {
    "figelo": {
      "url": "http://localhost:3870/mcp"
    }
  }
}
```

#### 4. Custom Connector

Pilih sesuai tipe koneksi yang didukung custom connector Anda:

- **HTTP (Streamable HTTP MCP — Direkomendasikan):**
  - Connection: **HTTP** (Streamable HTTP URL)
  - Server name: `figelo-mcp`
  - Endpoint URL: `http://localhost:3870/mcp`
- **Local Command (Stdio MCP):**
  - Command: `figelo-mcp`
  - Args: `["stdio"]`
  *(Atau tanpa `npm link`: command `node` dengan args `["/path/ke/FigeloMCP/dist/cli.js", "stdio"]`)*
- **REST API:**
  - Daftar tool & schema: `GET http://127.0.0.1:3870/api/tools`
  - Jalankan tool: `POST http://127.0.0.1:3870/api/call` dengan body `{ "tool": "get_selection", "args": {} }`
- **WebSocket langsung:** `ws://127.0.0.1:3870` (`client_hello` lalu `call`)

### Use Case & Edge Case (Troubleshooting)

- **Banyak AI App Sekaligus**: Cukup **1 Hub + 1 plugin Figma**, lalu hubungkan Claude Code, Codex, Antigravity, Cursor, dan Custom Connector secara bersamaan tanpa saling memutus koneksi (`4001: Replaced by new mcp`).
- **Claude Code vs. Claude Desktop (menu `+ → Plugins`)**:
  - Perintah `claude mcp add ...` menyimpan config ke `~/.claude.json` (dipakai oleh Claude Code CLI & tab Code). Server ini **memang tidak muncul** di menu `+ → Plugins` Claude Desktop meskipun `claude mcp list` sudah menunjukkan `figelo ... √ Connected` — Anda bisa langsung menyuruh Claude memanggil `figelo` di chat/CLI.
  - Untuk memakai FigeloMCP di tab **Chat** Claude Desktop, jalankan `figelo-mcp connect claude-desktop` (atau `figelo-mcp connect`). Perintah ini otomatis mendeteksi `%LOCALAPPDATA%\Claude-Data\<package>\claude_desktop_config.json` (Windows MSIX) atau `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) dan menambahkan bridge `stdio` tanpa menghapus preferences Anda. Jangan lupa **Quit dari System Tray** (Windows) / **Cmd+Q** (macOS) lalu buka ulang Claude Desktop.
- **Custom Connector belum terbaca di sesi chat yang sedang berjalan**:
  - Pastikan URL HTTP berakhiran `/mcp` (`http://localhost:3870/mcp`), bukan `/mc`.
  - Mulai **sesi chat baru** / restart sesi agent agar daftar tool MCP yang baru dimuat ulang.
  - Pada beberapa client, plugin/connector perlu dipanggil dengan `@figelo-mcp` atau diaktifkan lewat toggle connector terlebih dahulu.
- **Mengirim link `figma.com/design/...`**:
  - FigeloMCP bekerja langsung pada dokumen yang **sedang terbuka di Figma Desktop** dengan plugin FigeloMCP aktif (bukan mengunduh file dari cloud URL). Pastikan file-nya dibuka di Figma Desktop dan jendela plugin tetap terbuka.
- **Error PowerShell `ExecutionPolicy` di Windows (`npm.ps1 cannot be loaded`)**:
  - Jalankan `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` sekali saja (tanpa Admin), atau gunakan `npm.cmd link` / `node dist/cli.js start -d`.
- **Error `allowedDomains` saat import plugin di Figma**:
  - Figma Desktop menolak alamat IP (`ws://127.0.0.1:3870`) di `manifest.json`. Gunakan `ws://localhost:3870–3875`.

---

## Built-in Design Agent SOP (`instructions`)

FigeloMCP ships with a built-in MCP server `instructions` block (Design Agent Operating Procedure) sent automatically to every connected MCP client on initialization:

- **Setup**: Confirm the active document/channel with `list_figma_documents`, then inspect with `get_pages` / `get_selection`.
- **Reference Rule**: Treat screenshots as visual references only — never embed a reference screenshot or full-UI raster into the output frame.
- **Discover First**: Call `search_design_system` before mutating anything to match existing typography, spacing, tokens, styles, and components (never blindly default to Inter).
- **Build**: Use one auto-layout wrapper frame clear of existing canvas content, batch sections in `execute_figma_js` (or `batch_create`), return created/mutated node IDs as string literals, reuse local components/variables/styles, and use `create_svg` / `figma.createNodeFromSvg` for icons.
- **Plugin API Safety**: 0–1 `{ r, g, b }` colors with `opacity` on paint, clone-modify-reassign `fills`/`strokes`, `loadFontAsync` before text edits, append children before `HUG`/`FILL` sizing, `resize()` before sizing modes, max one `setCurrentPageAsync()` per call, and never call `figma.notify()`.
- **Validate**: Run `audit_frame` + one `get_screenshot`, fix real visual/structural issues, then verify with one post-fix `get_screenshot`.

---

## Available Tools (38)

- **Multi-doc & Health**: `list_figma_documents`, `ping`
- **Design System Discovery & Validation**:
  - `search_design_system` (local components & component sets with `TEXT`/`BOOLEAN`/`VARIANT` properties, local styles, local variable collections/variables, plus enabled Team Library variables with optional keyword `query` & `limit`)
  - `audit_frame` (pre-screenshot structural validation: descendant counts, zero-size nodes, clipped/overflowing & truncated text nodes, suspicious `>= 80%` full-frame raster images, distinct fonts used, remaining `placeholder` sections, and unbound style warnings)
- **Design-to-Code & Visual**: `get_design_context` (deep node tree + layout/tokens + screenshot), `get_screenshot` (native MCP image block)
- **Inspect**: `get_document_info`, `get_pages`, `set_current_page`, `get_selection`, `set_selection`, `get_node`, `find_nodes`, `get_styles`, `get_variables`
- **Create & Batch**: `create_frame` (supports optional `placeholder: boolean`), `create_text`, `create_rectangle`, `create_ellipse`, `create_svg`, `create_component`, `create_instance`, `batch_create`
- **Design System & Variables**: `create_variable_collection`, `create_variable`, `set_variable_value`, `bind_variable`, `create_component_set`, `create_section`
- **Media & Structure**: `set_image_fill` (local `filePath`, `imageUrl`, or `imageBase64`), `clone_node`, `group_nodes`, `create_page`
- **Modify & Export**: `update_node` (supports optional `placeholder: boolean`), `set_auto_layout`, `delete_nodes`, `export_image`
- **Full Escape Hatch**: `execute_figma_js` (run arbitrary async Figma Plugin API scripts; returns structured `{ ok: false, error, safeToRetryWithoutCanvasRead, createdNodeIds }` metadata on errors and soft timeout warnings near the 45s limit)

## CLI Commands

| Command | Description |
| --- | --- |
| `figelo-mcp start [-d]` | Start the unified Hub (`-d` runs detached in background) |
| `figelo-mcp stop` | Stop the running Hub daemon |
| `figelo-mcp status` | Print Hub health, connected Figma docs, and active clients |
| `figelo-mcp connect [target]` | Auto-configure MCP in installed apps (`all`, `claude-desktop`, `claude-code`, `codex`, `antigravity`, `cursor`) |
| `figelo-mcp disconnect [target]` | Remove FigeloMCP config from installed apps |
| `figelo-mcp stdio` | Run stdio MCP bridge connected to the shared Hub |
| `figelo-mcp install-service` | Auto-start Hub on login (macOS LaunchAgent / Windows Startup) |
| `figelo-mcp uninstall-service` | Remove auto-start registration |
| `figelo-mcp setup` | Print ready-to-paste config snippets |

## Development

```bash
npm run typecheck
npm run build
npm test
```

## License

MIT

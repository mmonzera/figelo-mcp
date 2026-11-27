import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import { FIGELO_VERSION, type ToolJsonSchema } from '../shared/protocol.js';
import type { PluginBroker } from './plugin-broker.js';

export type ToolExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  shape: ZodRawShape;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, broker: PluginBroker) => Promise<unknown>;
}

const channelSchema = z
  .string()
  .optional()
  .describe('Optional Figma document channel, fileKey, or documentName when multiple Figma files are open');

const channelJsonProp = {
  type: 'string',
  description: 'Optional Figma document channel, fileKey, or documentName when multiple Figma files are open',
};

function forwardToPlugin(method: string, timeoutMs?: number) {
  return async (args: Record<string, unknown>, broker: PluginBroker) => {
    const { channel, ...params } = args;
    return broker.callPlugin(method, params, {
      channel: typeof channel === 'string' && channel.length > 0 ? channel : undefined,
      timeoutMs,
    });
  };
}

export const FIGELO_MCP_INSTRUCTIONS = [
  'FigeloMCP connects AI agents to Figma Desktop. Follow this Design Agent Operating Procedure:',
  '',
  '1. Setup: Call `list_figma_documents` first to confirm the active document/channel (pass `channel` when multiple Figma files are open), then inspect with `get_pages` and `get_selection`.',
  '2. Reference Rule: Screenshots are visual references only — NEVER embed a reference screenshot or full-UI raster image into the output frame.',
  '3. Discover First: Call `search_design_system` before mutating anything. Match existing typography, spacing, variables, styles, and components. Never blindly default to Inter.',
  '4. Build: Create one auto-layout wrapper frame clear of existing canvas content. Batch related sections in `execute_figma_js` (or `batch_create`) rather than one layer per call. Always return created/mutated node IDs as string literals. Reuse local components, variables, and styles. Use `create_svg` / `figma.createNodeFromSvg` for icons (never rotated primitives).',
  '5. Plugin API Rules:',
  '   - Colors use 0–1 `{ r, g, b }` with `opacity` on the paint object (not `a` inside `color`).',
  '   - Clone -> modify -> reassign `fills` and `strokes` arrays.',
  '   - Always `await figma.loadFontAsync()` (verified via `figma.listAvailableFontsAsync()`) before mutating text.',
  '   - Append children to auto-layout parents BEFORE setting `HUG` / `FILL` sizing; call `resize()` before sizing modes.',
  '   - Use at most one `await figma.setCurrentPageAsync()` per call; never call `figma.notify()`.',
  '   - If `execute_figma_js` returns `ok: false`, inspect `safeToRetryWithoutCanvasRead` and `createdNodeIds` before retrying.',
  '6. Validate: Run `audit_frame` + one `get_screenshot`, fix only real visual/structural issues, then take one post-fix `get_screenshot`.',
].join('\n');

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_figma_documents',
    description:
      'List all Figma documents currently connected to the FigeloMCP Hub, including their channel IDs, fileKeys, and active status.',
    shape: {},
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, broker) => ({
      activeChannel: broker.getActiveChannel(),
      documents: broker.listPlugins(),
    }),
  },
  {
    name: 'ping',
    description: 'Check connection health with the active (or specified) Figma document plugin.',
    shape: { channel: channelSchema },
    inputSchema: { type: 'object', properties: { channel: channelJsonProp } },
    run: forwardToPlugin('ping'),
  },
  {
    name: 'get_document_info',
    description: 'Get document metadata, pages, and active page for the connected Figma file.',
    shape: { channel: channelSchema },
    inputSchema: { type: 'object', properties: { channel: channelJsonProp } },
    run: forwardToPlugin('get_document_info'),
  },
  {
    name: 'get_pages',
    description: 'List all pages in the Figma document.',
    shape: { channel: channelSchema },
    inputSchema: { type: 'object', properties: { channel: channelJsonProp } },
    run: forwardToPlugin('get_pages'),
  },
  {
    name: 'set_current_page',
    description: 'Switch the active page in Figma by pageId or pageName.',
    shape: {
      pageId: z.string().optional().describe('Page node ID'),
      pageName: z.string().optional().describe('Page name'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Page node ID' },
        pageName: { type: 'string', description: 'Page name' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('set_current_page'),
  },
  {
    name: 'get_selection',
    description: 'Get currently selected nodes on the active Figma page.',
    shape: {
      maxDepth: z.number().int().min(0).max(5).optional().describe('Child traversal depth (default 2)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        maxDepth: { type: 'number', description: 'Child traversal depth (default 2)' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('get_selection'),
  },
  {
    name: 'set_selection',
    description: 'Select specific node IDs in Figma and optionally zoom viewport into view.',
    shape: {
      nodeIds: z.array(z.string()).describe('Array of node IDs to select'),
      scrollIntoView: z.boolean().optional().describe('Scroll viewport to selection (default true)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeIds'],
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' } },
        scrollIntoView: { type: 'boolean' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('set_selection'),
  },
  {
    name: 'get_node',
    description: 'Inspect a node tree by nodeId (layout, fills, strokes, typography, children).',
    shape: {
      nodeId: z.string().describe('Target Figma node ID'),
      maxDepth: z.number().int().min(0).max(6).optional().describe('Child traversal depth (default 2)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        maxDepth: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('get_node'),
  },
  {
    name: 'find_nodes',
    description: 'Search nodes on the current page (or inside a rootNodeId) by name substring and/or node type.',
    shape: {
      query: z.string().optional().describe('Case-insensitive name substring'),
      type: z.string().optional().describe('Figma node type e.g. FRAME, TEXT, COMPONENT, INSTANCE'),
      rootNodeId: z.string().optional().describe('Optional container node ID to search within'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 50)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string' },
        rootNodeId: { type: 'string' },
        limit: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('find_nodes'),
  },
  {
    name: 'get_styles',
    description: 'Get local paint, text, and effect styles defined in the Figma document.',
    shape: { channel: channelSchema },
    inputSchema: { type: 'object', properties: { channel: channelJsonProp } },
    run: forwardToPlugin('get_styles'),
  },
  {
    name: 'get_variables',
    description: 'Get local variable collections and variables in the Figma document.',
    shape: { channel: channelSchema },
    inputSchema: { type: 'object', properties: { channel: channelJsonProp } },
    run: forwardToPlugin('get_variables'),
  },
  {
    name: 'create_frame',
    description: 'Create a frame (with optional auto-layout, fill, stroke, cornerRadius, and parentId).',
    shape: {
      name: z.string().optional().describe('Frame name'),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      parentId: z.string().optional().describe('Optional parent frame/page node ID'),
      fillHex: z.string().optional().describe('Background fill color hex e.g. #FFFFFF'),
      strokeHex: z.string().optional().describe('Stroke color hex'),
      strokeWeight: z.number().optional(),
      cornerRadius: z.number().optional(),
      layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
      itemSpacing: z.number().optional(),
      paddingTop: z.number().optional(),
      paddingRight: z.number().optional(),
      paddingBottom: z.number().optional(),
      paddingLeft: z.number().optional(),
      primaryAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']).optional(),
      counterAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'BASELINE']).optional(),
      clipsContent: z.boolean().optional(),
      placeholder: z
        .boolean()
        .optional()
        .describe('Mark frame as a section placeholder (stored in pluginData with subtle dashed styling)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        parentId: { type: 'string' },
        fillHex: { type: 'string' },
        strokeHex: { type: 'string' },
        strokeWeight: { type: 'number' },
        cornerRadius: { type: 'number' },
        layoutMode: { type: 'string', enum: ['NONE', 'HORIZONTAL', 'VERTICAL'] },
        itemSpacing: { type: 'number' },
        paddingTop: { type: 'number' },
        paddingRight: { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft: { type: 'number' },
        primaryAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        counterAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'] },
        clipsContent: { type: 'boolean' },
        placeholder: { type: 'boolean' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_frame'),
  },
  {
    name: 'create_text',
    description: 'Create a text node with font, size, color, and alignment.',
    shape: {
      characters: z.string().describe('Text content'),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      fontFamily: z.string().optional().describe('Font family (default Inter)'),
      fontStyle: z.string().optional().describe('Font style e.g. Regular, Medium, SemiBold, Bold'),
      fontSize: z.number().positive().optional(),
      fillHex: z.string().optional().describe('Text color hex e.g. #111827'),
      textAlignHorizontal: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']).optional(),
      width: z.number().positive().optional().describe('Optional fixed width for text wrapping'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['characters'],
      properties: {
        characters: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        parentId: { type: 'string' },
        fontFamily: { type: 'string' },
        fontStyle: { type: 'string' },
        fontSize: { type: 'number' },
        fillHex: { type: 'string' },
        textAlignHorizontal: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] },
        width: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_text'),
  },
  {
    name: 'create_rectangle',
    description: 'Create a rectangle node with optional fill, stroke, and corner radius.',
    shape: {
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      parentId: z.string().optional(),
      fillHex: z.string().optional(),
      strokeHex: z.string().optional(),
      strokeWeight: z.number().optional(),
      cornerRadius: z.number().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        parentId: { type: 'string' },
        fillHex: { type: 'string' },
        strokeHex: { type: 'string' },
        strokeWeight: { type: 'number' },
        cornerRadius: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_rectangle'),
  },
  {
    name: 'create_ellipse',
    description: 'Create an ellipse / circle node with optional fill and stroke.',
    shape: {
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      parentId: z.string().optional(),
      fillHex: z.string().optional(),
      strokeHex: z.string().optional(),
      strokeWeight: z.number().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        parentId: { type: 'string' },
        fillHex: { type: 'string' },
        strokeHex: { type: 'string' },
        strokeWeight: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_ellipse'),
  },
  {
    name: 'create_svg',
    description: 'Create vector nodes from an SVG markup string.',
    shape: {
      svg: z.string().describe('Valid SVG markup string'),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      parentId: z.string().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['svg'],
      properties: {
        svg: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        parentId: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_svg'),
  },
  {
    name: 'create_component',
    description: 'Create a new Figma Component or convert an existing frame nodeId into a Component.',
    shape: {
      name: z.string().optional(),
      fromNodeId: z.string().optional().describe('Optional existing node ID to convert into a component'),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      fillHex: z.string().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        fromNodeId: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
        parentId: { type: 'string' },
        fillHex: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_component'),
  },
  {
    name: 'create_instance',
    description: 'Instantiate an existing Figma Component by componentId.',
    shape: {
      componentId: z.string().describe('Source component node ID'),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      name: z.string().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['componentId'],
      properties: {
        componentId: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        parentId: { type: 'string' },
        name: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_instance'),
  },
  {
    name: 'update_node',
    description: 'Update properties of an existing node (name, position, size, opacity, visible, fillHex, strokeHex, cornerRadius, characters, layoutSizing).',
    shape: {
      nodeId: z.string().describe('Target node ID'),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      opacity: z.number().min(0).max(1).optional(),
      visible: z.boolean().optional(),
      fillHex: z.string().optional(),
      strokeHex: z.string().optional(),
      strokeWeight: z.number().optional(),
      cornerRadius: z.number().optional(),
      characters: z.string().optional().describe('New text characters if node is TEXT'),
      layoutSizingHorizontal: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
      layoutSizingVertical: z.enum(['FIXED', 'HUG', 'FILL']).optional(),
      placeholder: z
        .boolean()
        .optional()
        .describe('Set or clear section placeholder marker and subtle dashed placeholder styling'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        opacity: { type: 'number' },
        visible: { type: 'boolean' },
        fillHex: { type: 'string' },
        strokeHex: { type: 'string' },
        strokeWeight: { type: 'number' },
        cornerRadius: { type: 'number' },
        characters: { type: 'string' },
        layoutSizingHorizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
        layoutSizingVertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
        placeholder: { type: 'boolean' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('update_node'),
  },
  {
    name: 'set_auto_layout',
    description: 'Configure auto-layout direction, spacing, padding, and alignment on a frame or component.',
    shape: {
      nodeId: z.string().describe('Target frame/component node ID'),
      layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']),
      itemSpacing: z.number().optional(),
      paddingTop: z.number().optional(),
      paddingRight: z.number().optional(),
      paddingBottom: z.number().optional(),
      paddingLeft: z.number().optional(),
      primaryAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']).optional(),
      counterAxisAlignItems: z.enum(['MIN', 'CENTER', 'MAX', 'BASELINE']).optional(),
      layoutWrap: z.enum(['NO_WRAP', 'WRAP']).optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'layoutMode'],
      properties: {
        nodeId: { type: 'string' },
        layoutMode: { type: 'string', enum: ['NONE', 'HORIZONTAL', 'VERTICAL'] },
        itemSpacing: { type: 'number' },
        paddingTop: { type: 'number' },
        paddingRight: { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft: { type: 'number' },
        primaryAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] },
        counterAxisAlignItems: { type: 'string', enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'] },
        layoutWrap: { type: 'string', enum: ['NO_WRAP', 'WRAP'] },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('set_auto_layout'),
  },
  {
    name: 'delete_nodes',
    description: 'Delete one or more nodes by ID.',
    shape: {
      nodeIds: z.array(z.string()).min(1).describe('Node IDs to delete'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeIds'],
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' } },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('delete_nodes'),
  },
  {
    name: 'export_image',
    description: 'Export a Figma node as PNG, SVG, JPG, or PDF (returns base64 data).',
    shape: {
      nodeId: z.string().describe('Node ID to export'),
      format: z.enum(['PNG', 'SVG', 'JPG', 'PDF']).optional().describe('Export format (default PNG)'),
      scale: z.number().positive().max(4).optional().describe('Export scale (default 2)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        format: { type: 'string', enum: ['PNG', 'SVG', 'JPG', 'PDF'] },
        scale: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('export_image', 45_000),
  },
  {
    name: 'execute_figma_js',
    description:
      'Execute custom async JavaScript inside the Figma Plugin sandbox with `figma` and `params` in scope. On error, returns structured `{ ok: false, error, safeToRetryWithoutCanvasRead, createdNodeIds }` metadata.',
    shape: {
      code: z.string().describe('Async function body receiving (figma, params). Return a JSON-serializable value.'),
      params: z.record(z.unknown()).optional().describe('Optional parameters passed to the script'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: 'string' },
        params: { type: 'object' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('execute_figma_js', 45_000),
  },
  {
    name: 'get_design_context',
    description:
      'Get full design-to-code context (deep node tree, computed layout, fills, strokes, typography, effects, bound variables, color/font summary, plus a visual PNG screenshot) for a nodeId or current selection.',
    shape: {
      nodeId: z.string().optional().describe('Target node ID (defaults to first selected node)'),
      maxDepth: z.number().int().min(0).max(10).optional().describe('Tree depth (default 4)'),
      includeScreenshot: z.boolean().optional().describe('Attach rendered PNG screenshot (default true)'),
      screenshotScale: z.number().positive().max(4).optional().describe('Screenshot scale (default 1)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        maxDepth: { type: 'number' },
        includeScreenshot: { type: 'boolean' },
        screenshotScale: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('get_design_context', 45_000),
  },
  {
    name: 'get_screenshot',
    description:
      'Capture a visual PNG/JPG screenshot of a node (or current selection / page) returned as a native image block for AI inspection.',
    shape: {
      nodeId: z.string().optional().describe('Target node ID (defaults to selection or current page)'),
      format: z.enum(['PNG', 'JPG']).optional().describe('Image format (default PNG)'),
      scale: z.number().positive().max(4).optional().describe('Export scale (default 2)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        format: { type: 'string', enum: ['PNG', 'JPG'] },
        scale: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('get_screenshot', 45_000),
  },
  {
    name: 'create_variable_collection',
    description: 'Create a Figma variable collection with optional named modes (e.g. ["Light", "Dark"]).',
    shape: {
      name: z.string().describe('Collection name'),
      modes: z.array(z.string()).optional().describe('Optional mode names e.g. ["Light", "Dark"]'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        modes: { type: 'array', items: { type: 'string' } },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_variable_collection'),
  },
  {
    name: 'create_variable',
    description: 'Create a design token variable (COLOR, FLOAT, STRING, BOOLEAN) inside a collection with optional mode values.',
    shape: {
      collectionId: z.string().describe('Target variable collection ID'),
      name: z.string().describe('Variable name e.g. color/bg/primary'),
      resolvedType: z.enum(['COLOR', 'FLOAT', 'STRING', 'BOOLEAN']),
      valuesByMode: z
        .record(z.unknown())
        .optional()
        .describe('Map of modeId or modeName to value (hex string for COLOR, or { aliasVariableId })'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['collectionId', 'name', 'resolvedType'],
      properties: {
        collectionId: { type: 'string' },
        name: { type: 'string' },
        resolvedType: { type: 'string', enum: ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'] },
        valuesByMode: { type: 'object' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_variable'),
  },
  {
    name: 'set_variable_value',
    description: 'Set or update a variable value for a specific mode (by modeId or modeName).',
    shape: {
      variableId: z.string().describe('Target variable ID'),
      value: z.unknown().describe('Value (hex string for COLOR, number, string, boolean, or { aliasVariableId })'),
      modeId: z.string().optional().describe('Target mode ID'),
      modeName: z.string().optional().describe('Target mode name e.g. Dark'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['variableId', 'value'],
      properties: {
        variableId: { type: 'string' },
        value: {},
        modeId: { type: 'string' },
        modeName: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('set_variable_value'),
  },
  {
    name: 'bind_variable',
    description:
      'Bind a Figma variable to a node field (fill, stroke, width, height, itemSpacing, paddingTop, paddingRight, paddingBottom, paddingLeft, topLeftRadius, opacity, etc.).',
    shape: {
      nodeId: z.string().describe('Target node ID'),
      variableId: z.string().describe('Variable ID to bind'),
      field: z.string().describe('Target property e.g. fill, stroke, itemSpacing, paddingLeft, topLeftRadius, width'),
      paintIndex: z.number().int().min(0).optional().describe('Paint index when field is fill or stroke (default 0)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId', 'variableId', 'field'],
      properties: {
        nodeId: { type: 'string' },
        variableId: { type: 'string' },
        field: { type: 'string' },
        paintIndex: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('bind_variable'),
  },
  {
    name: 'create_component_set',
    description: 'Combine 2 or more existing Components into a Variant ComponentSet.',
    shape: {
      componentIds: z.array(z.string()).min(2).describe('Component node IDs to combine as variants'),
      name: z.string().optional(),
      parentId: z.string().optional(),
      layoutMode: z.enum(['NONE', 'HORIZONTAL', 'VERTICAL']).optional(),
      itemSpacing: z.number().optional(),
      padding: z.number().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['componentIds'],
      properties: {
        componentIds: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        parentId: { type: 'string' },
        layoutMode: { type: 'string', enum: ['NONE', 'HORIZONTAL', 'VERTICAL'] },
        itemSpacing: { type: 'number' },
        padding: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_component_set'),
  },
  {
    name: 'create_section',
    description: 'Create a Figma Section on the canvas and optionally move childNodeIds inside it.',
    shape: {
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fillHex: z.string().optional(),
      parentId: z.string().optional(),
      childNodeIds: z.array(z.string()).optional().describe('Optional existing node IDs to place inside the section'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        fillHex: { type: 'string' },
        parentId: { type: 'string' },
        childNodeIds: { type: 'array', items: { type: 'string' } },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_section'),
  },
  {
    name: 'set_image_fill',
    description: 'Set an image fill on a node from a local filePath, remote imageUrl, or base64 string.',
    shape: {
      nodeId: z.string().describe('Target node ID'),
      filePath: z.string().optional().describe('Local image file path on disk (PNG/JPG/WebP)'),
      imageUrl: z.string().optional().describe('HTTP/HTTPS image URL to fetch'),
      imageBase64: z.string().optional().describe('Raw or data-URI base64 image bytes'),
      scaleMode: z.enum(['FILL', 'FIT', 'CROP', 'TILE']).optional().describe('Image scaleMode (default FILL)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        filePath: { type: 'string' },
        imageUrl: { type: 'string' },
        imageBase64: { type: 'string' },
        scaleMode: { type: 'string', enum: ['FILL', 'FIT', 'CROP', 'TILE'] },
        channel: channelJsonProp,
      },
    },
    run: async (args, broker) => {
      const { nodeId, filePath, imageUrl, imageBase64, scaleMode, channel } = args;
      let resolvedBase64 = '';
      if (typeof filePath === 'string' && filePath.length > 0) {
        resolvedBase64 = readFileSync(filePath).toString('base64');
      } else if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        const res = await fetch(imageUrl);
        if (!res.ok) {
          throw new Error(`Failed to fetch imageUrl (${res.status} ${res.statusText})`);
        }
        resolvedBase64 = Buffer.from(await res.arrayBuffer()).toString('base64');
      } else if (typeof imageBase64 === 'string' && imageBase64.length > 0) {
        resolvedBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '');
      } else {
        throw new Error('Provide one of filePath, imageUrl, or imageBase64');
      }

      return broker.callPlugin(
        'set_image_fill',
        { nodeId, imageBase64: resolvedBase64, scaleMode },
        {
          channel: typeof channel === 'string' && channel.length > 0 ? channel : undefined,
          timeoutMs: 45_000,
        },
      );
    },
  },
  {
    name: 'clone_node',
    description: 'Duplicate an existing node with optional new name, position, and parentId.',
    shape: {
      nodeId: z.string().describe('Source node ID to clone'),
      name: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      parentId: z.string().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        parentId: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('clone_node'),
  },
  {
    name: 'group_nodes',
    description: 'Group one or more nodes together with an optional group name.',
    shape: {
      nodeIds: z.array(z.string()).min(1).describe('Node IDs to group'),
      name: z.string().optional(),
      parentId: z.string().optional(),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeIds'],
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        parentId: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('group_nodes'),
  },
  {
    name: 'create_page',
    description: 'Create a new page in the Figma document and optionally switch to it.',
    shape: {
      name: z.string().optional().describe('Page name'),
      switchTo: z.boolean().optional().describe('Switch active page to the new page (default true)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        switchTo: { type: 'boolean' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('create_page'),
  },
  {
    name: 'batch_create',
    description:
      'Create a nested UI tree of frames, texts, shapes, SVGs, components, and instances in a single call.',
    shape: {
      parentId: z.string().optional().describe('Optional container node ID (defaults to current page)'),
      nodes: z
        .array(z.record(z.unknown()))
        .min(1)
        .describe('Array of node specs ({ type: "FRAME"|"TEXT"|"RECTANGLE"|"ELLIPSE"|"SVG"|"COMPONENT"|"INSTANCE", children?: [...], ...props })'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodes'],
      properties: {
        parentId: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('batch_create', 45_000),
  },
  {
    name: 'search_design_system',
    description:
      'Discover local components, component sets (with properties/variant options), local styles, local variable collections/variables, and enabled Team Library variables in one compact read-only call.',
    shape: {
      query: z.string().optional().describe('Optional case-insensitive keyword/substring filter'),
      includeVariables: z.boolean().optional().describe('Include local and library variables (default true)'),
      includeStyles: z.boolean().optional().describe('Include local text, paint, and effect styles (default true)'),
      includeComponents: z.boolean().optional().describe('Include local components and component sets (default true)'),
      limit: z.number().int().min(1).max(200).optional().describe('Max items per category (default 50)'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        includeVariables: { type: 'boolean' },
        includeStyles: { type: 'boolean' },
        includeComponents: { type: 'boolean' },
        limit: { type: 'number' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('search_design_system', 45_000),
  },
  {
    name: 'audit_frame',
    description:
      'Run automated pre-screenshot structural and visual validation on a frame (node counts, zero-size nodes, clipped/overflowing nodes, suspicious full-frame raster images, fonts used, placeholder sections, and unbound style warnings).',
    shape: {
      nodeId: z.string().describe('Target frame or wrapper node ID to audit'),
      channel: channelSchema,
    },
    inputSchema: {
      type: 'object',
      required: ['nodeId'],
      properties: {
        nodeId: { type: 'string' },
        channel: channelJsonProp,
      },
    },
    run: forwardToPlugin('audit_frame', 45_000),
  },
];

const TOOL_MAP = new Map<string, ToolDefinition>(
  TOOL_DEFINITIONS.map((t) => [t.name, t]),
);

export function getToolsJsonSchemas(): ToolJsonSchema[] {
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export async function executeToolWithBroker(
  broker: PluginBroker,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const def = TOOL_MAP.get(toolName);
  if (!def) {
    throw new Error(`Unknown tool: "${toolName}"`);
  }
  const parser = z.object(def.shape);
  const parsed = parser.parse(args);
  return def.run(parsed as Record<string, unknown>, broker);
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Formats plugin tool output into MCP content blocks, emitting native image blocks
 * for screenshot responses without bloating text output with raw base64 data.
 */
export function formatMcpToolResult(
  toolName: string,
  result: unknown,
): { content: McpContentBlock[] } {
  if (
    toolName === 'get_screenshot' &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result)
  ) {
    const rec = result as Record<string, unknown>;
    if (typeof rec.base64 === 'string' && typeof rec.mimeType === 'string') {
      const { base64, ...meta } = rec;
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', data: base64, mimeType: rec.mimeType },
        ],
      };
    }
  }

  if (
    toolName === 'get_design_context' &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result)
  ) {
    const rec = result as Record<string, unknown>;
    const ss = rec.screenshot;
    if (ss && typeof ss === 'object' && !Array.isArray(ss)) {
      const ssRec = ss as Record<string, unknown>;
      if (typeof ssRec.base64 === 'string' && typeof ssRec.mimeType === 'string') {
        const { base64, ...ssMeta } = ssRec;
        const sanitized = { ...rec, screenshot: ssMeta };
        return {
          content: [
            { type: 'text', text: JSON.stringify(sanitized, null, 2) },
            { type: 'image', data: base64, mimeType: ssRec.mimeType },
          ],
        };
      }
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

export function createFigeloMcpServer(executor: ToolExecutor): McpServer {
  const server = new McpServer(
    { name: 'FigeloMCP', version: FIGELO_VERSION },
    {
      instructions: FIGELO_MCP_INSTRUCTIONS,
    },
  );

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.shape,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await executor(def.name, args ?? {});
          return formatMcpToolResult(def.name, result);
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: err instanceof Error ? err.message : String(err),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

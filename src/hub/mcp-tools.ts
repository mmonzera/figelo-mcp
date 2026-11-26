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
      'Execute custom async JavaScript inside the Figma Plugin sandbox with `figma` and `params` in scope. Useful as a full-power escape hatch for any Figma Plugin API operation.',
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

export function createFigeloMcpServer(executor: ToolExecutor): McpServer {
  const server = new McpServer(
    { name: 'FigeloMCP', version: FIGELO_VERSION },
    {
      instructions:
        'FigeloMCP connects multiple AI coding agents and custom harnesses simultaneously to Figma Desktop. ' +
        'Use list_figma_documents if multiple Figma files are open, and pass `channel` to target a specific document.',
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
          return {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
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

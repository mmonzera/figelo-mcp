/**
 * FigeloMCP Plugin Sandbox (code.ts)
 *
 * Executes Figma Plugin API commands sequentially via an internal async queue
 * so concurrent requests from multiple AI clients never interleave mutations.
 */

const PLUGIN_VERSION = '0.1.0';
const CHANNEL_STORAGE_PREFIX = 'figelo_channel_';

type HandlerFn = (params: Record<string, unknown>) => Promise<unknown>;

const handlers = new Map<string, HandlerFn>();

// ─── Serial Task Queue ───
let queueTail: Promise<void> = Promise.resolve();

function enqueueTask<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ─── Helpers ───

function parseHexColor(hex: string): { color: RGB; opacity: number } {
  const clean = hex.trim().replace(/^#/, '');
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 1;

  if (clean.length === 3 || clean.length === 4) {
    r = parseInt(clean[0] + clean[0], 16) / 255;
    g = parseInt(clean[1] + clean[1], 16) / 255;
    b = parseInt(clean[2] + clean[2], 16) / 255;
    if (clean.length === 4) {
      a = parseInt(clean[3] + clean[3], 16) / 255;
    }
  } else if (clean.length === 6 || clean.length === 8) {
    r = parseInt(clean.slice(0, 2), 16) / 255;
    g = parseInt(clean.slice(2, 4), 16) / 255;
    b = parseInt(clean.slice(4, 6), 16) / 255;
    if (clean.length === 8) {
      a = parseInt(clean.slice(6, 8), 16) / 255;
    }
  } else {
    throw new Error(`Invalid hex color: "${hex}"`);
  }

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) {
    throw new Error(`Invalid hex color: "${hex}"`);
  }

  return { color: { r, g, b }, opacity: a };
}

function makeSolidPaint(hex: string): SolidPaint {
  const { color, opacity } = parseHexColor(hex);
  return {
    type: 'SOLID',
    color,
    opacity,
  };
}

function rgbToHex(color: RGB): string {
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

async function resolveParent(parentId?: unknown): Promise<BaseNode & ChildrenMixin> {
  if (typeof parentId === 'string' && parentId.length > 0) {
    const parent = await figma.getNodeByIdAsync(parentId);
    if (!parent) {
      throw new Error(`Parent node "${parentId}" not found`);
    }
    if (!('appendChild' in parent)) {
      throw new Error(`Node "${parentId}" (${parent.type}) cannot contain children`);
    }
    return parent as BaseNode & ChildrenMixin;
  }
  return figma.currentPage;
}

async function loadFontSafe(family = 'Inter', style = 'Regular'): Promise<FontName> {
  const candidates: FontName[] = [
    { family, style },
    { family, style: 'Regular' },
    { family: 'Inter', style },
    { family: 'Inter', style: 'Regular' },
    { family: 'Roboto', style: 'Regular' },
  ];

  for (const font of candidates) {
    try {
      await figma.loadFontAsync(font);
      return font;
    } catch {
      // try next fallback
    }
  }
  throw new Error(`Could not load font "${family} ${style}" or fallback Inter Regular`);
}

function serializeNode(node: BaseNode, maxDepth = 2, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if ('visible' in node) out.visible = node.visible;
  if ('x' in node) out.x = node.x;
  if ('y' in node) out.y = node.y;
  if ('width' in node) out.width = node.width;
  if ('height' in node) out.height = node.height;
  if ('opacity' in node) out.opacity = node.opacity;
  if ('cornerRadius' in node && typeof node.cornerRadius === 'number') {
    out.cornerRadius = node.cornerRadius;
  }
  if ('layoutMode' in node) {
    out.layoutMode = node.layoutMode;
    if (node.layoutMode !== 'NONE') {
      out.itemSpacing = node.itemSpacing;
      out.paddingTop = node.paddingTop;
      out.paddingRight = node.paddingRight;
      out.paddingBottom = node.paddingBottom;
      out.paddingLeft = node.paddingLeft;
      out.primaryAxisAlignItems = node.primaryAxisAlignItems;
      out.counterAxisAlignItems = node.counterAxisAlignItems;
    }
  }
  if ('fills' in node && Array.isArray(node.fills)) {
    out.fills = node.fills
      .filter((p): p is SolidPaint => p.type === 'SOLID' && p.visible !== false)
      .map((p) => ({
        type: p.type,
        hex: rgbToHex(p.color),
        opacity: p.opacity ?? 1,
      }));
  }
  if (node.type === 'TEXT') {
    out.characters = node.characters;
    if (typeof node.fontSize === 'number') out.fontSize = node.fontSize;
    if (node.fontName !== figma.mixed && typeof node.fontName === 'object') {
      out.fontName = node.fontName;
    }
    out.textAlignHorizontal = node.textAlignHorizontal;
  }
  if ('children' in node) {
    if (depth < maxDepth) {
      out.children = node.children.map((c) => serializeNode(c, maxDepth, depth + 1));
    } else {
      out.childCount = node.children.length;
    }
  }

  return out;
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result +=
      chars[(n >> 18) & 63] +
      chars[(n >> 12) & 63] +
      chars[(n >> 6) & 63] +
      chars[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem === 2 ? bytes[i + 1] : 0;
    const n = (b0 << 16) | (b1 << 8);
    result += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    result += rem === 2 ? chars[(n >> 6) & 63] : '=';
    result += '=';
  }
  return result;
}

function base64ToUint8(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, '').replace(/[\r\n\s]/g, '');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  let pad = 0;
  if (clean.endsWith('==')) pad = 2;
  else if (clean.endsWith('=')) pad = 1;

  const byteLen = Math.floor((clean.length * 3) / 4) - pad;
  const out = new Uint8Array(Math.max(0, byteLen));
  let ptr = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = lookup[clean.charCodeAt(i)] ?? 0;
    const c1 = lookup[clean.charCodeAt(i + 1)] ?? 0;
    const c2 = clean[i + 2] === '=' ? 0 : (lookup[clean.charCodeAt(i + 2)] ?? 0);
    const c3 = clean[i + 3] === '=' ? 0 : (lookup[clean.charCodeAt(i + 3)] ?? 0);
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (ptr < byteLen) out[ptr++] = (n >> 16) & 0xff;
    if (ptr < byteLen) out[ptr++] = (n >> 8) & 0xff;
    if (ptr < byteLen) out[ptr++] = n & 0xff;
  }
  return out;
}

function serializePaints(paints: readonly Paint[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const p of paints) {
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      out.push({ type: 'SOLID', hex: rgbToHex(p.color), opacity: p.opacity ?? 1 });
    } else if (
      p.type === 'GRADIENT_LINEAR' ||
      p.type === 'GRADIENT_RADIAL' ||
      p.type === 'GRADIENT_ANGULAR' ||
      p.type === 'GRADIENT_DIAMOND'
    ) {
      out.push({
        type: p.type,
        opacity: p.opacity ?? 1,
        stops: p.gradientStops.map((s) => ({
          position: s.position,
          hex: rgbToHex({ r: s.color.r, g: s.color.g, b: s.color.b }),
          alpha: s.color.a,
        })),
      });
    } else if (p.type === 'IMAGE') {
      out.push({
        type: 'IMAGE',
        imageHash: p.imageHash,
        scaleMode: p.scaleMode,
        opacity: p.opacity ?? 1,
      });
    }
  }
  return out;
}

function serializeDesignNode(
  node: BaseNode,
  maxDepth = 4,
  depth = 0,
  collector?: { colors: Set<string>; fonts: Set<string>; boundVariableIds: Set<string> },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if ('visible' in node) out.visible = node.visible;
  if ('x' in node) out.x = node.x;
  if ('y' in node) out.y = node.y;
  if ('width' in node) out.width = node.width;
  if ('height' in node) out.height = node.height;
  if ('opacity' in node) out.opacity = node.opacity;

  if ('cornerRadius' in node) {
    if (typeof node.cornerRadius === 'number') {
      out.cornerRadius = node.cornerRadius;
    } else if ('topLeftRadius' in node) {
      const rect = node as RectangleNode;
      out.cornerRadius = {
        topLeft: rect.topLeftRadius,
        topRight: rect.topRightRadius,
        bottomRight: rect.bottomRightRadius,
        bottomLeft: rect.bottomLeftRadius,
      };
    }
  }

  if ('layoutMode' in node) {
    out.layoutMode = node.layoutMode;
    if (node.layoutMode !== 'NONE') {
      out.itemSpacing = node.itemSpacing;
      out.paddingTop = node.paddingTop;
      out.paddingRight = node.paddingRight;
      out.paddingBottom = node.paddingBottom;
      out.paddingLeft = node.paddingLeft;
      out.primaryAxisAlignItems = node.primaryAxisAlignItems;
      out.counterAxisAlignItems = node.counterAxisAlignItems;
      if ('layoutWrap' in node) out.layoutWrap = node.layoutWrap;
    }
  }
  if ('layoutSizingHorizontal' in node) out.layoutSizingHorizontal = node.layoutSizingHorizontal;
  if ('layoutSizingVertical' in node) out.layoutSizingVertical = node.layoutSizingVertical;

  if ('fills' in node && Array.isArray(node.fills)) {
    const fills = serializePaints(node.fills);
    if (fills.length > 0) out.fills = fills;
    if (collector) {
      for (const f of fills) {
        if (typeof f.hex === 'string') collector.colors.add(f.hex);
      }
    }
  }

  if ('strokes' in node && Array.isArray(node.strokes)) {
    const strokes = serializePaints(node.strokes);
    if (strokes.length > 0) {
      out.strokes = strokes;
      if ('strokeWeight' in node && typeof node.strokeWeight === 'number') {
        out.strokeWeight = node.strokeWeight;
      }
      if (collector) {
        for (const s of strokes) {
          if (typeof s.hex === 'string') collector.colors.add(s.hex);
        }
      }
    }
  }

  if ('effects' in node && Array.isArray(node.effects) && node.effects.length > 0) {
    out.effects = node.effects
      .filter((e) => e.visible !== false)
      .map((e) => {
        const eff: Record<string, unknown> = { type: e.type };
        if ('radius' in e) eff.radius = e.radius;
        if ('offset' in e) eff.offset = e.offset;
        if ('spread' in e) eff.spread = e.spread;
        if ('color' in e && e.color) {
          eff.hex = rgbToHex({ r: e.color.r, g: e.color.g, b: e.color.b });
          eff.alpha = e.color.a;
        }
        return eff;
      });
  }

  if (node.type === 'TEXT') {
    out.characters = node.characters;
    if (typeof node.fontSize === 'number') out.fontSize = node.fontSize;
    if (node.fontName !== figma.mixed && typeof node.fontName === 'object') {
      out.fontName = node.fontName;
      if (collector) {
        collector.fonts.add(`${node.fontName.family} ${node.fontName.style}`);
      }
    }
    if (node.lineHeight !== figma.mixed) out.lineHeight = node.lineHeight;
    if (node.letterSpacing !== figma.mixed) out.letterSpacing = node.letterSpacing;
    out.textAlignHorizontal = node.textAlignHorizontal;
    if (node.textDecoration !== figma.mixed) out.textDecoration = node.textDecoration;
  }

  if ('boundVariables' in node && node.boundVariables) {
    const bv = node.boundVariables as Record<string, unknown>;
    const keys = Object.keys(bv).filter((k) => bv[k] !== undefined);
    if (keys.length > 0) {
      out.boundVariables = bv;
      if (collector) {
        for (const k of keys) {
          const val = bv[k];
          if (Array.isArray(val)) {
            for (const item of val) {
              if (item && typeof item === 'object' && 'id' in item && typeof (item as { id?: unknown }).id === 'string') {
                collector.boundVariableIds.add((item as { id: string }).id);
              }
            }
          } else if (val && typeof val === 'object' && 'id' in val && typeof (val as { id?: unknown }).id === 'string') {
            collector.boundVariableIds.add((val as { id: string }).id);
          }
        }
      }
    }
  }

  if ('children' in node) {
    if (depth < maxDepth) {
      out.children = node.children.map((c) => serializeDesignNode(c, maxDepth, depth + 1, collector));
    } else {
      out.childCount = node.children.length;
    }
  }

  return out;
}

function coerceVariableValue(raw: unknown, resolvedType: VariableResolvedDataType): VariableValue {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.aliasVariableId === 'string') {
      return { type: 'VARIABLE_ALIAS', id: obj.aliasVariableId };
    }
    if (obj.type === 'VARIABLE_ALIAS' && typeof obj.id === 'string') {
      return { type: 'VARIABLE_ALIAS', id: obj.id };
    }
  }
  if (resolvedType === 'COLOR' && typeof raw === 'string') {
    const { color, opacity } = parseHexColor(raw);
    return { r: color.r, g: color.g, b: color.b, a: opacity };
  }
  return raw as VariableValue;
}

function resolveModeIdFromCollection(collection: VariableCollection, key: string): string {
  const byId = collection.modes.find((m) => m.modeId === key);
  if (byId) return byId.modeId;
  const byName = collection.modes.find((m) => m.name.toLowerCase() === key.toLowerCase());
  if (byName) return byName.modeId;
  throw new Error(`Mode "${key}" not found in collection "${collection.name}"`);
}

async function createNodeFromParams(
  kind: string,
  params: Record<string, unknown>,
  parent: BaseNode & ChildrenMixin,
): Promise<SceneNode> {
  const upper = kind.toUpperCase();
  let created: SceneNode;

  if (upper === 'FRAME') {
    const frame = figma.createFrame();
    frame.name = typeof params.name === 'string' ? params.name : 'Frame';
    frame.resize(
      typeof params.width === 'number' ? params.width : 320,
      typeof params.height === 'number' ? params.height : 200,
    );
    if (typeof params.fillHex === 'string') frame.fills = [makeSolidPaint(params.fillHex)];
    if (typeof params.strokeHex === 'string') {
      frame.strokes = [makeSolidPaint(params.strokeHex)];
      frame.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
    }
    if (typeof params.cornerRadius === 'number') frame.cornerRadius = params.cornerRadius;
    if (typeof params.clipsContent === 'boolean') frame.clipsContent = params.clipsContent;
    if (
      params.layoutMode === 'HORIZONTAL' ||
      params.layoutMode === 'VERTICAL' ||
      params.layoutMode === 'NONE'
    ) {
      frame.layoutMode = params.layoutMode;
      if (params.layoutMode !== 'NONE') {
        if (typeof params.itemSpacing === 'number') frame.itemSpacing = params.itemSpacing;
        if (typeof params.paddingTop === 'number') frame.paddingTop = params.paddingTop;
        if (typeof params.paddingRight === 'number') frame.paddingRight = params.paddingRight;
        if (typeof params.paddingBottom === 'number') frame.paddingBottom = params.paddingBottom;
        if (typeof params.paddingLeft === 'number') frame.paddingLeft = params.paddingLeft;
        if (typeof params.primaryAxisAlignItems === 'string') {
          frame.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode['primaryAxisAlignItems'];
        }
        if (typeof params.counterAxisAlignItems === 'string') {
          frame.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode['counterAxisAlignItems'];
        }
      }
    }
    created = frame;
  } else if (upper === 'TEXT') {
    const fontFamily = typeof params.fontFamily === 'string' ? params.fontFamily : 'Inter';
    const fontStyle = typeof params.fontStyle === 'string' ? params.fontStyle : 'Regular';
    const loadedFont = await loadFontSafe(fontFamily, fontStyle);
    const text = figma.createText();
    text.fontName = loadedFont;
    text.characters = String(params.characters ?? '');
    if (typeof params.name === 'string') text.name = params.name;
    if (typeof params.fontSize === 'number') text.fontSize = params.fontSize;
    if (typeof params.fillHex === 'string') text.fills = [makeSolidPaint(params.fillHex)];
    if (typeof params.textAlignHorizontal === 'string') {
      text.textAlignHorizontal = params.textAlignHorizontal as TextNode['textAlignHorizontal'];
    }
    if (typeof params.width === 'number') {
      text.textAutoResize = 'HEIGHT';
      text.resize(params.width, text.height);
    }
    created = text;
  } else if (upper === 'RECTANGLE') {
    const rect = figma.createRectangle();
    rect.name = typeof params.name === 'string' ? params.name : 'Rectangle';
    rect.resize(
      typeof params.width === 'number' ? params.width : 100,
      typeof params.height === 'number' ? params.height : 100,
    );
    if (typeof params.fillHex === 'string') rect.fills = [makeSolidPaint(params.fillHex)];
    if (typeof params.strokeHex === 'string') {
      rect.strokes = [makeSolidPaint(params.strokeHex)];
      rect.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
    }
    if (typeof params.cornerRadius === 'number') rect.cornerRadius = params.cornerRadius;
    created = rect;
  } else if (upper === 'ELLIPSE') {
    const ellipse = figma.createEllipse();
    ellipse.name = typeof params.name === 'string' ? params.name : 'Ellipse';
    ellipse.resize(
      typeof params.width === 'number' ? params.width : 80,
      typeof params.height === 'number' ? params.height : 80,
    );
    if (typeof params.fillHex === 'string') ellipse.fills = [makeSolidPaint(params.fillHex)];
    if (typeof params.strokeHex === 'string') {
      ellipse.strokes = [makeSolidPaint(params.strokeHex)];
      ellipse.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
    }
    created = ellipse;
  } else if (upper === 'SVG') {
    const node = figma.createNodeFromSvg(String(params.svg ?? ''));
    if (typeof params.name === 'string') node.name = params.name;
    if (typeof params.width === 'number' && typeof params.height === 'number') {
      node.resize(params.width, params.height);
    }
    created = node;
  } else if (upper === 'COMPONENT') {
    const comp = figma.createComponent();
    comp.name = typeof params.name === 'string' ? params.name : 'Component';
    comp.resize(
      typeof params.width === 'number' ? params.width : 200,
      typeof params.height === 'number' ? params.height : 100,
    );
    if (typeof params.fillHex === 'string') comp.fills = [makeSolidPaint(params.fillHex)];
    created = comp;
  } else if (upper === 'INSTANCE') {
    const componentId = String(params.componentId ?? '');
    const comp = await figma.getNodeByIdAsync(componentId);
    if (!comp || comp.type !== 'COMPONENT') {
      throw new Error(`Component "${componentId}" not found`);
    }
    const inst = comp.createInstance();
    if (typeof params.name === 'string') inst.name = params.name;
    created = inst;
  } else {
    throw new Error(`Unsupported batch node type: "${kind}"`);
  }

  if (typeof params.x === 'number') created.x = params.x;
  if (typeof params.y === 'number') created.y = params.y;
  parent.appendChild(created);

  if (typeof params.layoutSizingHorizontal === 'string' && 'layoutSizingHorizontal' in created) {
    (created as FrameNode).layoutSizingHorizontal = params.layoutSizingHorizontal as FrameNode['layoutSizingHorizontal'];
  }
  if (typeof params.layoutSizingVertical === 'string' && 'layoutSizingVertical' in created) {
    (created as FrameNode).layoutSizingVertical = params.layoutSizingVertical as FrameNode['layoutSizingVertical'];
  }

  return created;
}

// ─── Handlers ───

handlers.set('ping', async () => ({
  status: 'ok',
  pluginVersion: PLUGIN_VERSION,
  documentName: figma.root.name,
  fileKey: figma.fileKey ?? null,
  currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
  timestamp: Date.now(),
}));

handlers.set('get_document_info', async () => {
  await figma.loadAllPagesAsync();
  return {
    name: figma.root.name,
    fileKey: figma.fileKey ?? null,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    pages: figma.root.children.map((p) => ({
      id: p.id,
      name: p.name,
      isCurrent: p.id === figma.currentPage.id,
    })),
  };
});

handlers.set('get_pages', async () => {
  await figma.loadAllPagesAsync();
  return figma.root.children.map((p) => ({
    id: p.id,
    name: p.name,
    isCurrent: p.id === figma.currentPage.id,
  }));
});

handlers.set('set_current_page', async (params) => {
  await figma.loadAllPagesAsync();
  const pageId = typeof params.pageId === 'string' ? params.pageId : undefined;
  const pageName = typeof params.pageName === 'string' ? params.pageName : undefined;
  const target = figma.root.children.find(
    (p) => (pageId && p.id === pageId) || (pageName && p.name === pageName),
  );
  if (!target) {
    throw new Error(`Page not found (pageId=${pageId ?? ''}, pageName=${pageName ?? ''})`);
  }
  await figma.setCurrentPageAsync(target);
  return { id: target.id, name: target.name };
});

handlers.set('get_selection', async (params) => {
  const maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 2;
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    count: figma.currentPage.selection.length,
    nodes: figma.currentPage.selection.map((n) => serializeNode(n, maxDepth)),
  };
});

handlers.set('set_selection', async (params) => {
  const nodeIds = Array.isArray(params.nodeIds)
    ? params.nodeIds.filter((v): v is string => typeof v === 'string')
    : [];
  const resolved = await Promise.all(nodeIds.map((id) => figma.getNodeByIdAsync(id)));
  const sceneNodes = resolved.filter(
    (n): n is SceneNode => n !== null && n.type !== 'DOCUMENT' && n.type !== 'PAGE',
  );
  figma.currentPage.selection = sceneNodes;
  if (params.scrollIntoView !== false && sceneNodes.length > 0) {
    figma.viewport.scrollAndZoomIntoView(sceneNodes);
  }
  return { selectedCount: sceneNodes.length, nodeIds: sceneNodes.map((n) => n.id) };
});

handlers.set('get_node', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 2;
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  return serializeNode(node, maxDepth);
});

handlers.set('find_nodes', async (params) => {
  const query = typeof params.query === 'string' ? params.query.toLowerCase() : '';
  const typeFilter = typeof params.type === 'string' ? params.type.toUpperCase() : '';
  const limit = typeof params.limit === 'number' ? params.limit : 50;

  let root: BaseNode = figma.currentPage;
  if (typeof params.rootNodeId === 'string' && params.rootNodeId.length > 0) {
    const foundRoot = await figma.getNodeByIdAsync(params.rootNodeId);
    if (!foundRoot) throw new Error(`Root node "${params.rootNodeId}" not found`);
    root = foundRoot;
  }

  const results: Array<Record<string, unknown>> = [];
  function walk(node: BaseNode) {
    if (results.length >= limit) return;
    if (node.id !== root.id) {
      const matchName = !query || node.name.toLowerCase().includes(query);
      const matchType = !typeFilter || node.type === typeFilter;
      if (matchName && matchType) {
        results.push(serializeNode(node, 0));
      }
    }
    if ('children' in node && results.length < limit) {
      for (const child of node.children) {
        walk(child);
        if (results.length >= limit) break;
      }
    }
  }
  walk(root);
  return { count: results.length, nodes: results };
});

handlers.set('get_styles', async () => {
  const [paints, texts, effects] = await Promise.all([
    figma.getLocalPaintStylesAsync(),
    figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(),
  ]);
  return {
    paintStyles: paints.map((s) => ({ id: s.id, name: s.name })),
    textStyles: texts.map((s) => ({
      id: s.id,
      name: s.name,
      fontSize: s.fontSize,
      fontName: s.fontName,
    })),
    effectStyles: effects.map((s) => ({ id: s.id, name: s.name })),
  };
});

handlers.set('get_variables', async () => {
  const [collections, variables] = await Promise.all([
    figma.variables.getLocalVariableCollectionsAsync(),
    figma.variables.getLocalVariablesAsync(),
  ]);
  return {
    collections: collections.map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes,
      variableCount: c.variableIds.length,
    })),
    variables: variables.map((v) => ({
      id: v.id,
      name: v.name,
      resolvedType: v.resolvedType,
      variableCollectionId: v.variableCollectionId,
      valuesByMode: v.valuesByMode,
    })),
  };
});

handlers.set('create_frame', async (params) => {
  const parent = await resolveParent(params.parentId);
  const frame = figma.createFrame();
  frame.name = typeof params.name === 'string' ? params.name : 'Frame';
  const w = typeof params.width === 'number' ? params.width : 320;
  const h = typeof params.height === 'number' ? params.height : 200;
  frame.resize(w, h);
  if (typeof params.x === 'number') frame.x = params.x;
  if (typeof params.y === 'number') frame.y = params.y;
  if (typeof params.fillHex === 'string') frame.fills = [makeSolidPaint(params.fillHex)];
  if (typeof params.strokeHex === 'string') {
    frame.strokes = [makeSolidPaint(params.strokeHex)];
    frame.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
  }
  if (typeof params.cornerRadius === 'number') frame.cornerRadius = params.cornerRadius;
  if (typeof params.clipsContent === 'boolean') frame.clipsContent = params.clipsContent;

  if (
    params.layoutMode === 'HORIZONTAL' ||
    params.layoutMode === 'VERTICAL' ||
    params.layoutMode === 'NONE'
  ) {
    frame.layoutMode = params.layoutMode;
    if (params.layoutMode !== 'NONE') {
      if (typeof params.itemSpacing === 'number') frame.itemSpacing = params.itemSpacing;
      if (typeof params.paddingTop === 'number') frame.paddingTop = params.paddingTop;
      if (typeof params.paddingRight === 'number') frame.paddingRight = params.paddingRight;
      if (typeof params.paddingBottom === 'number') frame.paddingBottom = params.paddingBottom;
      if (typeof params.paddingLeft === 'number') frame.paddingLeft = params.paddingLeft;
      if (typeof params.primaryAxisAlignItems === 'string') {
        frame.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode['primaryAxisAlignItems'];
      }
      if (typeof params.counterAxisAlignItems === 'string') {
        frame.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode['counterAxisAlignItems'];
      }
    }
  }

  parent.appendChild(frame);
  return serializeNode(frame, 1);
});

handlers.set('create_text', async (params) => {
  const parent = await resolveParent(params.parentId);
  const fontFamily = typeof params.fontFamily === 'string' ? params.fontFamily : 'Inter';
  const fontStyle = typeof params.fontStyle === 'string' ? params.fontStyle : 'Regular';
  const loadedFont = await loadFontSafe(fontFamily, fontStyle);

  const text = figma.createText();
  text.fontName = loadedFont;
  text.characters = String(params.characters ?? '');
  if (typeof params.name === 'string') text.name = params.name;
  if (typeof params.x === 'number') text.x = params.x;
  if (typeof params.y === 'number') text.y = params.y;
  if (typeof params.fontSize === 'number') text.fontSize = params.fontSize;
  if (typeof params.fillHex === 'string') text.fills = [makeSolidPaint(params.fillHex)];
  if (typeof params.textAlignHorizontal === 'string') {
    text.textAlignHorizontal = params.textAlignHorizontal as TextNode['textAlignHorizontal'];
  }
  if (typeof params.width === 'number') {
    text.textAutoResize = 'HEIGHT';
    text.resize(params.width, text.height);
  }

  parent.appendChild(text);
  return serializeNode(text, 0);
});

handlers.set('create_rectangle', async (params) => {
  const parent = await resolveParent(params.parentId);
  const rect = figma.createRectangle();
  rect.name = typeof params.name === 'string' ? params.name : 'Rectangle';
  rect.resize(
    typeof params.width === 'number' ? params.width : 100,
    typeof params.height === 'number' ? params.height : 100,
  );
  if (typeof params.x === 'number') rect.x = params.x;
  if (typeof params.y === 'number') rect.y = params.y;
  if (typeof params.fillHex === 'string') rect.fills = [makeSolidPaint(params.fillHex)];
  if (typeof params.strokeHex === 'string') {
    rect.strokes = [makeSolidPaint(params.strokeHex)];
    rect.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
  }
  if (typeof params.cornerRadius === 'number') rect.cornerRadius = params.cornerRadius;

  parent.appendChild(rect);
  return serializeNode(rect, 0);
});

handlers.set('create_ellipse', async (params) => {
  const parent = await resolveParent(params.parentId);
  const ellipse = figma.createEllipse();
  ellipse.name = typeof params.name === 'string' ? params.name : 'Ellipse';
  ellipse.resize(
    typeof params.width === 'number' ? params.width : 80,
    typeof params.height === 'number' ? params.height : 80,
  );
  if (typeof params.x === 'number') ellipse.x = params.x;
  if (typeof params.y === 'number') ellipse.y = params.y;
  if (typeof params.fillHex === 'string') ellipse.fills = [makeSolidPaint(params.fillHex)];
  if (typeof params.strokeHex === 'string') {
    ellipse.strokes = [makeSolidPaint(params.strokeHex)];
    ellipse.strokeWeight = typeof params.strokeWeight === 'number' ? params.strokeWeight : 1;
  }

  parent.appendChild(ellipse);
  return serializeNode(ellipse, 0);
});

handlers.set('create_svg', async (params) => {
  const parent = await resolveParent(params.parentId);
  const svgStr = String(params.svg ?? '');
  const node = figma.createNodeFromSvg(svgStr);
  if (typeof params.name === 'string') node.name = params.name;
  if (typeof params.x === 'number') node.x = params.x;
  if (typeof params.y === 'number') node.y = params.y;
  if (typeof params.width === 'number' && typeof params.height === 'number') {
    node.resize(params.width, params.height);
  }
  parent.appendChild(node);
  return serializeNode(node, 1);
});

handlers.set('create_component', async (params) => {
  if (typeof params.fromNodeId === 'string' && params.fromNodeId.length > 0) {
    const existing = await figma.getNodeByIdAsync(params.fromNodeId);
    if (!existing) throw new Error(`Node "${params.fromNodeId}" not found`);
    if (existing.type === 'COMPONENT') return serializeNode(existing, 1);
    if (existing.type !== 'FRAME' && existing.type !== 'GROUP') {
      throw new Error(`Cannot convert ${existing.type} to Component`);
    }
    const comp = figma.createComponentFromNode(existing);
    if (typeof params.name === 'string') comp.name = params.name;
    return serializeNode(comp, 1);
  }

  const parent = await resolveParent(params.parentId);
  const comp = figma.createComponent();
  comp.name = typeof params.name === 'string' ? params.name : 'Component';
  comp.resize(
    typeof params.width === 'number' ? params.width : 200,
    typeof params.height === 'number' ? params.height : 100,
  );
  if (typeof params.x === 'number') comp.x = params.x;
  if (typeof params.y === 'number') comp.y = params.y;
  if (typeof params.fillHex === 'string') comp.fills = [makeSolidPaint(params.fillHex)];
  parent.appendChild(comp);
  return serializeNode(comp, 1);
});

handlers.set('create_instance', async (params) => {
  const componentId = String(params.componentId ?? '');
  const comp = await figma.getNodeByIdAsync(componentId);
  if (!comp || comp.type !== 'COMPONENT') {
    throw new Error(`Component "${componentId}" not found`);
  }
  const parent = await resolveParent(params.parentId);
  const instance = comp.createInstance();
  if (typeof params.name === 'string') instance.name = params.name;
  if (typeof params.x === 'number') instance.x = params.x;
  if (typeof params.y === 'number') instance.y = params.y;
  parent.appendChild(instance);
  return serializeNode(instance, 1);
});

handlers.set('update_node', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node "${nodeId}" not found`);

  if (typeof params.name === 'string') node.name = params.name;
  if (typeof params.visible === 'boolean' && 'visible' in node) node.visible = params.visible;
  if (typeof params.opacity === 'number' && 'opacity' in node) node.opacity = params.opacity;
  if (typeof params.x === 'number' && 'x' in node) node.x = params.x;
  if (typeof params.y === 'number' && 'y' in node) node.y = params.y;
  if ((typeof params.width === 'number' || typeof params.height === 'number') && 'resize' in node) {
    const sn = node as SceneNode & { width: number; height: number; resize: (w: number, h: number) => void };
    sn.resize(
      typeof params.width === 'number' ? params.width : sn.width,
      typeof params.height === 'number' ? params.height : sn.height,
    );
  }
  if (typeof params.fillHex === 'string' && 'fills' in node) {
    (node as GeometryMixin).fills = [makeSolidPaint(params.fillHex)];
  }
  if (typeof params.strokeHex === 'string' && 'strokes' in node) {
    (node as GeometryMixin).strokes = [makeSolidPaint(params.strokeHex)];
    if (typeof params.strokeWeight === 'number' && 'strokeWeight' in node) {
      (node as GeometryMixin).strokeWeight = params.strokeWeight;
    }
  }
  if (typeof params.cornerRadius === 'number' && 'cornerRadius' in node) {
    (node as CornerMixin).cornerRadius = params.cornerRadius;
  }
  if (typeof params.characters === 'string' && node.type === 'TEXT') {
    const font =
      node.fontName !== figma.mixed
        ? node.fontName
        : { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(font);
    node.characters = params.characters;
  }
  if (typeof params.layoutSizingHorizontal === 'string' && 'layoutSizingHorizontal' in node) {
    (node as FrameNode).layoutSizingHorizontal = params.layoutSizingHorizontal as FrameNode['layoutSizingHorizontal'];
  }
  if (typeof params.layoutSizingVertical === 'string' && 'layoutSizingVertical' in node) {
    (node as FrameNode).layoutSizingVertical = params.layoutSizingVertical as FrameNode['layoutSizingVertical'];
  }

  return serializeNode(node, 1);
});

handlers.set('set_auto_layout', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || (node.type !== 'FRAME' && node.type !== 'COMPONENT')) {
    throw new Error(`Node "${nodeId}" must be a FRAME or COMPONENT`);
  }
  const layoutMode = String(params.layoutMode) as FrameNode['layoutMode'];
  node.layoutMode = layoutMode;
  if (layoutMode !== 'NONE') {
    if (typeof params.itemSpacing === 'number') node.itemSpacing = params.itemSpacing;
    if (typeof params.paddingTop === 'number') node.paddingTop = params.paddingTop;
    if (typeof params.paddingRight === 'number') node.paddingRight = params.paddingRight;
    if (typeof params.paddingBottom === 'number') node.paddingBottom = params.paddingBottom;
    if (typeof params.paddingLeft === 'number') node.paddingLeft = params.paddingLeft;
    if (typeof params.primaryAxisAlignItems === 'string') {
      node.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode['primaryAxisAlignItems'];
    }
    if (typeof params.counterAxisAlignItems === 'string') {
      node.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode['counterAxisAlignItems'];
    }
    if (typeof params.layoutWrap === 'string') {
      node.layoutWrap = params.layoutWrap as FrameNode['layoutWrap'];
    }
  }
  return serializeNode(node, 1);
});

handlers.set('delete_nodes', async (params) => {
  const ids = Array.isArray(params.nodeIds)
    ? params.nodeIds.filter((v): v is string => typeof v === 'string')
    : [];
  let deleted = 0;
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
      node.remove();
      deleted++;
    }
  }
  return { deleted, requested: ids.length };
});

handlers.set('export_image', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !('exportAsync' in node)) {
    throw new Error(`Exportable node "${nodeId}" not found`);
  }
  const format = (typeof params.format === 'string' ? params.format : 'PNG') as 'PNG' | 'SVG' | 'JPG' | 'PDF';
  const scale = typeof params.scale === 'number' ? params.scale : 2;
  const bytes = await (node as SceneNode).exportAsync(
    format === 'SVG' || format === 'PDF'
      ? { format }
      : { format, constraint: { type: 'SCALE', value: scale } },
  );
  return {
    nodeId,
    format,
    byteLength: bytes.length,
    base64: uint8ToBase64(bytes),
  };
});

handlers.set('execute_figma_js', async (params) => {
  const code = String(params.code ?? '');
  const scriptParams =
    params.params && typeof params.params === 'object' ? params.params : {};
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (figmaApi: PluginAPI, p: unknown) => Promise<unknown>;
  const fn = new AsyncFunction('figma', 'params', code);
  const result = await fn(figma, scriptParams);
  return result === undefined ? { ok: true } : result;
});

handlers.set('get_design_context', async (params) => {
  let target: BaseNode | null = null;
  if (typeof params.nodeId === 'string' && params.nodeId.length > 0) {
    target = await figma.getNodeByIdAsync(params.nodeId);
    if (!target) throw new Error(`Node "${params.nodeId}" not found`);
  } else if (figma.currentPage.selection.length > 0) {
    target = figma.currentPage.selection[0];
  } else {
    throw new Error('Provide nodeId or select a node in Figma first');
  }

  const maxDepth = typeof params.maxDepth === 'number' ? params.maxDepth : 4;
  const collector = {
    colors: new Set<string>(),
    fonts: new Set<string>(),
    boundVariableIds: new Set<string>(),
  };
  const serialized = serializeDesignNode(target, maxDepth, 0, collector);

  const out: Record<string, unknown> = {
    node: serialized,
    summary: {
      colors: Array.from(collector.colors),
      fonts: Array.from(collector.fonts),
      boundVariableIds: Array.from(collector.boundVariableIds),
    },
  };

  if (params.includeScreenshot !== false && 'exportAsync' in target) {
    const scale = typeof params.screenshotScale === 'number' ? params.screenshotScale : 1;
    const bytes = await (target as SceneNode).exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: scale },
    });
    out.screenshot = {
      mimeType: 'image/png',
      byteLength: bytes.length,
      base64: uint8ToBase64(bytes),
    };
  }

  return out;
});

handlers.set('get_screenshot', async (params) => {
  let target: BaseNode | null = null;
  if (typeof params.nodeId === 'string' && params.nodeId.length > 0) {
    target = await figma.getNodeByIdAsync(params.nodeId);
    if (!target) throw new Error(`Node "${params.nodeId}" not found`);
  } else if (figma.currentPage.selection.length > 0) {
    target = figma.currentPage.selection[0];
  } else {
    target = figma.currentPage;
  }

  if (!('exportAsync' in target)) {
    throw new Error(`Node "${target.id}" (${target.type}) is not exportable`);
  }

  const format = params.format === 'JPG' ? 'JPG' : 'PNG';
  const scale = typeof params.scale === 'number' ? params.scale : 2;
  const bytes = await (target as SceneNode | PageNode).exportAsync({
    format,
    constraint: { type: 'SCALE', value: scale },
  });

  return {
    nodeId: target.id,
    nodeName: target.name,
    format,
    mimeType: format === 'JPG' ? 'image/jpeg' : 'image/png',
    byteLength: bytes.length,
    base64: uint8ToBase64(bytes),
  };
});

handlers.set('create_variable_collection', async (params) => {
  const name = String(params.name ?? '').trim();
  if (!name) throw new Error('Collection name is required');
  const collection = figma.variables.createVariableCollection(name);

  if (Array.isArray(params.modes) && params.modes.length > 0) {
    const modeNames = params.modes.filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    if (modeNames.length > 0 && collection.modes.length > 0) {
      collection.renameMode(collection.modes[0].modeId, modeNames[0]);
      for (let i = 1; i < modeNames.length; i++) {
        collection.addMode(modeNames[i]);
      }
    }
  }

  return {
    id: collection.id,
    name: collection.name,
    modes: collection.modes,
  };
});

handlers.set('create_variable', async (params) => {
  const name = String(params.name ?? '').trim();
  const collectionId = String(params.collectionId ?? '');
  const resolvedType = String(params.resolvedType ?? '') as VariableResolvedDataType;
  if (!name) throw new Error('Variable name is required');

  const collection = await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!collection) throw new Error(`Variable collection "${collectionId}" not found`);

  const variable = figma.variables.createVariable(name, collection, resolvedType);

  if (params.valuesByMode && typeof params.valuesByMode === 'object') {
    const entries = Object.entries(params.valuesByMode as Record<string, unknown>);
    for (const [modeKey, rawVal] of entries) {
      const modeId = resolveModeIdFromCollection(collection, modeKey);
      variable.setValueForMode(modeId, coerceVariableValue(rawVal, resolvedType));
    }
  }

  return {
    id: variable.id,
    name: variable.name,
    resolvedType: variable.resolvedType,
    variableCollectionId: variable.variableCollectionId,
    valuesByMode: variable.valuesByMode,
  };
});

handlers.set('set_variable_value', async (params) => {
  const variableId = String(params.variableId ?? '');
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) throw new Error(`Variable "${variableId}" not found`);

  const collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
  if (!collection) throw new Error(`Collection for variable "${variableId}" not found`);

  const modeKey =
    typeof params.modeId === 'string' && params.modeId
      ? params.modeId
      : typeof params.modeName === 'string' && params.modeName
        ? params.modeName
        : collection.defaultModeId;

  const modeId = resolveModeIdFromCollection(collection, modeKey);
  variable.setValueForMode(modeId, coerceVariableValue(params.value, variable.resolvedType));

  return {
    id: variable.id,
    name: variable.name,
    resolvedType: variable.resolvedType,
    modeId,
    valuesByMode: variable.valuesByMode,
  };
});

handlers.set('bind_variable', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const variableId = String(params.variableId ?? '');
  const field = String(params.field ?? '');

  const [node, variable] = await Promise.all([
    figma.getNodeByIdAsync(nodeId),
    figma.variables.getVariableByIdAsync(variableId),
  ]);
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  if (!variable) throw new Error(`Variable "${variableId}" not found`);

  if (field === 'fill' || field === 'stroke') {
    const prop = field === 'fill' ? 'fills' : 'strokes';
    if (!(prop in node)) {
      throw new Error(`Node "${nodeId}" (${node.type}) does not support ${prop}`);
    }
    const geo = node as GeometryMixin;
    const current = Array.isArray(geo[prop]) ? [...(geo[prop] as Paint[])] : [];
    const idx = typeof params.paintIndex === 'number' ? params.paintIndex : 0;
    while (current.length <= idx) {
      current.push(makeSolidPaint('#000000'));
    }
    const targetPaint = current[idx];
    if (targetPaint.type !== 'SOLID') {
      throw new Error(`Paint at index ${idx} must be SOLID to bind a color variable`);
    }
    current[idx] = figma.variables.setBoundVariableForPaint(targetPaint, 'color', variable);
    geo[prop] = current;
    return { nodeId, variableId, field, paintIndex: idx, bound: true };
  }

  if (!('setBoundVariable' in node)) {
    throw new Error(`Node "${nodeId}" (${node.type}) does not support variable binding`);
  }
  (node as unknown as { setBoundVariable: (f: VariableBindableNodeField, v: Variable | null) => void }).setBoundVariable(
    field as VariableBindableNodeField,
    variable,
  );
  return { nodeId, variableId, field, bound: true };
});

handlers.set('create_component_set', async (params) => {
  const ids = Array.isArray(params.componentIds)
    ? params.componentIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length < 2) {
    throw new Error('Provide at least 2 componentIds to create a component set');
  }

  const resolved = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
  const components: ComponentNode[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const n = resolved[i];
    if (!n || n.type !== 'COMPONENT') {
      throw new Error(`Node "${ids[i]}" is not a COMPONENT`);
    }
    components.push(n);
  }

  const parent =
    typeof params.parentId === 'string' && params.parentId.length > 0
      ? await resolveParent(params.parentId)
      : (components[0].parent && 'appendChild' in components[0].parent
          ? (components[0].parent as BaseNode & ChildrenMixin)
          : figma.currentPage);

  const set = figma.combineAsVariants(components, parent);
  if (typeof params.name === 'string') set.name = params.name;
  if (params.layoutMode === 'HORIZONTAL' || params.layoutMode === 'VERTICAL' || params.layoutMode === 'NONE') {
    set.layoutMode = params.layoutMode;
    if (params.layoutMode !== 'NONE') {
      if (typeof params.itemSpacing === 'number') set.itemSpacing = params.itemSpacing;
      if (typeof params.padding === 'number') {
        set.paddingTop = params.padding;
        set.paddingRight = params.padding;
        set.paddingBottom = params.padding;
        set.paddingLeft = params.padding;
      }
    }
  }
  return serializeNode(set, 1);
});

handlers.set('create_section', async (params) => {
  const parent = await resolveParent(params.parentId);
  const section = figma.createSection();
  section.name = typeof params.name === 'string' ? params.name : 'Section';
  if (typeof params.x === 'number') section.x = params.x;
  if (typeof params.y === 'number') section.y = params.y;
  section.resizeWithoutConstraints(
    typeof params.width === 'number' ? params.width : 800,
    typeof params.height === 'number' ? params.height : 600,
  );
  if (typeof params.fillHex === 'string') {
    section.fills = [makeSolidPaint(params.fillHex)];
  }
  parent.appendChild(section);

  if (Array.isArray(params.childNodeIds)) {
    for (const id of params.childNodeIds) {
      if (typeof id !== 'string') continue;
      const child = await figma.getNodeByIdAsync(id);
      if (child && child.type !== 'DOCUMENT' && child.type !== 'PAGE') {
        section.appendChild(child as SceneNode);
      }
    }
  }

  return serializeNode(section, 1);
});

handlers.set('set_image_fill', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const imageBase64 = String(params.imageBase64 ?? '');
  if (!imageBase64) throw new Error('imageBase64 is required');

  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || !('fills' in node)) {
    throw new Error(`Node "${nodeId}" not found or does not support fills`);
  }

  const bytes = base64ToUint8(imageBase64);
  const image = figma.createImage(bytes);
  const scaleMode = (
    params.scaleMode === 'FIT' || params.scaleMode === 'CROP' || params.scaleMode === 'TILE'
      ? params.scaleMode
      : 'FILL'
  ) as ImagePaint['scaleMode'];

  (node as GeometryMixin).fills = [
    {
      type: 'IMAGE',
      imageHash: image.hash,
      scaleMode,
    },
  ];

  return { nodeId, imageHash: image.hash, scaleMode };
});

handlers.set('clone_node', async (params) => {
  const nodeId = String(params.nodeId ?? '');
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type === 'DOCUMENT' || node.type === 'PAGE' || !('clone' in node)) {
    throw new Error(`Cloneable node "${nodeId}" not found`);
  }

  const cloned = (node as SceneNode).clone();
  if (typeof params.parentId === 'string' && params.parentId.length > 0) {
    const parent = await resolveParent(params.parentId);
    parent.appendChild(cloned);
  }
  if (typeof params.name === 'string') cloned.name = params.name;
  if (typeof params.x === 'number') cloned.x = params.x;
  if (typeof params.y === 'number') cloned.y = params.y;

  return serializeNode(cloned, 1);
});

handlers.set('group_nodes', async (params) => {
  const ids = Array.isArray(params.nodeIds)
    ? params.nodeIds.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) throw new Error('Provide at least 1 nodeId to group');

  const resolved = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
  const nodes = resolved.filter(
    (n): n is SceneNode => n !== null && n.type !== 'DOCUMENT' && n.type !== 'PAGE',
  );
  if (nodes.length === 0) throw new Error('No valid SceneNodes found to group');

  const parent =
    typeof params.parentId === 'string' && params.parentId.length > 0
      ? await resolveParent(params.parentId)
      : (nodes[0].parent && 'appendChild' in nodes[0].parent
          ? (nodes[0].parent as BaseNode & ChildrenMixin)
          : figma.currentPage);

  const group = figma.group(nodes, parent);
  if (typeof params.name === 'string') group.name = params.name;
  return serializeNode(group, 1);
});

handlers.set('create_page', async (params) => {
  const page = figma.createPage();
  if (typeof params.name === 'string' && params.name.trim().length > 0) {
    page.name = params.name;
  }
  if (params.switchTo !== false) {
    await figma.setCurrentPageAsync(page);
  }
  return {
    id: page.id,
    name: page.name,
    isCurrent: page.id === figma.currentPage.id,
  };
});

handlers.set('batch_create', async (params) => {
  const rootParent = await resolveParent(params.parentId);
  const specs = Array.isArray(params.nodes) ? params.nodes : [];
  let createdCount = 0;

  async function buildTree(
    items: unknown[],
    parent: BaseNode & ChildrenMixin,
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const spec = raw as Record<string, unknown>;
      const kind = typeof spec.type === 'string' ? spec.type : 'FRAME';
      const node = await createNodeFromParams(kind, spec, parent);
      createdCount++;
      const summary: Record<string, unknown> = {
        id: node.id,
        name: node.name,
        type: node.type,
      };
      if (Array.isArray(spec.children) && spec.children.length > 0 && 'appendChild' in node) {
        summary.children = await buildTree(spec.children, node as BaseNode & ChildrenMixin);
      }
      out.push(summary);
    }
    return out;
  }

  const nodes = await buildTree(specs, rootParent);
  return { createdCount, nodes };
});

// ─── UI Bridge ───

figma.showUI(__html__, { visible: true, width: 340, height: 480 });

function makeDefaultChannel(): string {
  if (figma.fileKey) return figma.fileKey;
  const slug = figma.root.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return slug || 'figma-doc';
}

async function sendInitInfo() {
  const storageKey = CHANNEL_STORAGE_PREFIX + (figma.fileKey || figma.root.name);
  const savedChannel = await figma.clientStorage.getAsync(storageKey);
  figma.ui.postMessage({
    type: 'init_doc',
    channel: typeof savedChannel === 'string' && savedChannel ? savedChannel : makeDefaultChannel(),
    documentName: figma.root.name,
    fileKey: figma.fileKey ?? null,
    currentPage: figma.currentPage.name,
    pluginVersion: PLUGIN_VERSION,
  });
}

void sendInitInfo();

figma.ui.on(
  'message',
  async (msg: {
    type?: string;
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    channel?: string;
  }) => {
    if (msg.type === 'save_channel' && msg.channel) {
      const storageKey = CHANNEL_STORAGE_PREFIX + (figma.fileKey || figma.root.name);
      await figma.clientStorage.setAsync(storageKey, msg.channel);
      return;
    }

    if (msg.type === 'request' && msg.id && msg.method) {
      const reqId = msg.id;
      const method = msg.method;
      const params = msg.params ?? {};

      try {
        const result = await enqueueTask(async () => {
          const handler = handlers.get(method);
          if (!handler) {
            throw new Error(`Unknown plugin method: ${method}`);
          }
          return handler(params);
        });

        figma.ui.postMessage({
          type: 'response',
          id: reqId,
          result,
        });
      } catch (err) {
        figma.ui.postMessage({
          type: 'error',
          id: reqId,
          error: {
            code: 'PLUGIN_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  },
);

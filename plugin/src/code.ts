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

/**
 * Pure, runtime-agnostic helpers shared between the Figma plugin sandbox
 * (bundled via esbuild, ES2017 target) and Node/Vitest unit tests.
 */

export const PLACEHOLDER_PLUGIN_DATA_KEY = 'figelo_placeholder';
export const EXECUTE_JS_TIMEOUT_MS = 45_000;
export const EXECUTE_JS_SOFT_WARN_MS = 30_000;

// ─── 1. execute_figma_js Retry-Safety & Timeout Warning ───

export interface CanvasNodeFingerprint {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  childIds: string[];
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
  characters?: string;
  fillsCount?: number;
  strokesCount?: number;
}

export interface CanvasSnapshot {
  currentPageId: string;
  pageIds: string[];
  nodes: Record<string, CanvasNodeFingerprint>;
}

export interface ExecuteJsErrorResult {
  ok: false;
  error: string;
  safeToRetryWithoutCanvasRead: boolean;
  createdNodeIds: string[];
  warning?: string;
}

export interface ClassifyExecuteJsFailureInput {
  error: unknown;
  beforeSnapshot?: CanvasSnapshot | null;
  afterSnapshot?: CanvasSnapshot | null;
  trackedCreatedIds?: Iterable<string>;
  trackedMutated?: boolean;
  elapsedMs?: number;
  timeoutMs?: number;
  softWarnMs?: number;
}

export function evaluateExecuteJsTimeoutWarning(
  elapsedMs: number,
  timeoutMs = EXECUTE_JS_TIMEOUT_MS,
  softWarnMs = EXECUTE_JS_SOFT_WARN_MS,
): string | undefined {
  if (elapsedMs >= softWarnMs) {
    return `Script executed in ${Math.round(elapsedMs)}ms, close to the ${timeoutMs}ms timeout. Consider splitting work into smaller batches.`;
  }
  return undefined;
}

function fingerprintsEqual(a: CanvasNodeFingerprint, b: CanvasNodeFingerprint): boolean {
  if (
    a.name !== b.name ||
    a.type !== b.type ||
    a.parentId !== b.parentId ||
    a.x !== b.x ||
    a.y !== b.y ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.visible !== b.visible ||
    a.characters !== b.characters ||
    a.fillsCount !== b.fillsCount ||
    a.strokesCount !== b.strokesCount
  ) {
    return false;
  }
  if (a.childIds.length !== b.childIds.length) return false;
  for (let i = 0; i < a.childIds.length; i++) {
    if (a.childIds[i] !== b.childIds[i]) return false;
  }
  return true;
}

export function diffCanvasSnapshots(
  before: CanvasSnapshot | null | undefined,
  after: CanvasSnapshot | null | undefined,
): { mutated: boolean; createdNodeIds: string[] } {
  if (!before || !after) {
    return { mutated: false, createdNodeIds: [] };
  }

  const createdNodeIds: string[] = [];
  let mutated = false;

  if (before.currentPageId !== after.currentPageId) {
    mutated = true;
  }

  const beforePageSet = new Set(before.pageIds);
  for (const pid of after.pageIds) {
    if (!beforePageSet.has(pid)) {
      createdNodeIds.push(pid);
      mutated = true;
    }
  }
  if (before.pageIds.length !== after.pageIds.length) {
    mutated = true;
  }

  const beforeKeys = Object.keys(before.nodes);
  const afterKeys = Object.keys(after.nodes);

  for (const id of afterKeys) {
    if (!(id in before.nodes)) {
      createdNodeIds.push(id);
      mutated = true;
    } else if (!fingerprintsEqual(before.nodes[id], after.nodes[id])) {
      mutated = true;
    }
  }

  if (!mutated) {
    for (const id of beforeKeys) {
      if (!(id in after.nodes)) {
        mutated = true;
        break;
      }
    }
  }

  return { mutated, createdNodeIds };
}

export function classifyExecuteJsFailure(
  input: ClassifyExecuteJsFailureInput,
): ExecuteJsErrorResult {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);

  const diff = diffCanvasSnapshots(input.beforeSnapshot, input.afterSnapshot);
  const createdSet = new Set<string>(diff.createdNodeIds);
  if (input.trackedCreatedIds) {
    for (const id of input.trackedCreatedIds) {
      if (typeof id === 'string' && id.length > 0) {
        createdSet.add(id);
      }
    }
  }

  const createdNodeIds = Array.from(createdSet);
  const mutated = Boolean(input.trackedMutated) || diff.mutated || createdNodeIds.length > 0;

  const result: ExecuteJsErrorResult = {
    ok: false,
    error: message,
    safeToRetryWithoutCanvasRead: !mutated,
    createdNodeIds,
  };

  if (typeof input.elapsedMs === 'number') {
    const warning = evaluateExecuteJsTimeoutWarning(
      input.elapsedMs,
      input.timeoutMs,
      input.softWarnMs,
    );
    if (warning) {
      result.warning = warning;
    }
  }

  return result;
}

// ─── 2. search_design_system Inventory & Filtering ───

export interface DesignSystemComponentProperty {
  name: string;
  type: 'TEXT' | 'BOOLEAN' | 'VARIANT' | 'INSTANCE_SWAP' | string;
  defaultValue?: unknown;
  variantOptions?: string[];
}

export interface DesignSystemComponentItem {
  id: string;
  key: string;
  name: string;
  type: 'COMPONENT' | 'COMPONENT_SET';
  description: string;
  properties: DesignSystemComponentProperty[];
}

export interface DesignSystemStyleItem {
  id: string;
  key: string;
  name: string;
}

export interface DesignSystemVariableCollectionItem {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variableCount: number;
}

export interface DesignSystemVariableItem {
  id: string;
  name: string;
  resolvedType: string;
  collectionId: string;
  collectionName: string;
}

export interface DesignSystemLibraryCollectionItem {
  key: string;
  name: string;
  libraryName: string;
}

export interface DesignSystemLibraryVariableItem {
  key: string;
  name: string;
  resolvedType: string;
  collectionKey: string;
  collectionName: string;
  libraryName: string;
}

export interface RawDesignSystemInventory {
  components: DesignSystemComponentItem[];
  styles: {
    textStyles: DesignSystemStyleItem[];
    paintStyles: DesignSystemStyleItem[];
    effectStyles: DesignSystemStyleItem[];
  };
  localVariables: {
    collections: DesignSystemVariableCollectionItem[];
    variables: DesignSystemVariableItem[];
  };
  libraryVariables: {
    collections: DesignSystemLibraryCollectionItem[];
    variables: DesignSystemLibraryVariableItem[];
    unavailableReason?: string;
  };
}

export interface SearchDesignSystemOptions {
  query?: string;
  includeVariables?: boolean;
  includeStyles?: boolean;
  includeComponents?: boolean;
  limit?: number;
}

export interface FilteredDesignSystemInventory {
  query: string | null;
  limit: number;
  components?: {
    total: number;
    items: DesignSystemComponentItem[];
  };
  styles?: {
    textStyles: DesignSystemStyleItem[];
    paintStyles: DesignSystemStyleItem[];
    effectStyles: DesignSystemStyleItem[];
    totals: { text: number; paint: number; effect: number };
  };
  localVariables?: {
    collections: DesignSystemVariableCollectionItem[];
    variables: DesignSystemVariableItem[];
    totalVariables: number;
  };
  libraryVariables?: {
    collections: DesignSystemLibraryCollectionItem[];
    variables: DesignSystemLibraryVariableItem[];
    totalVariables: number;
    unavailableReason?: string;
  };
}

function matchesQuery(queryTokens: string[], fields: Array<string | undefined>): boolean {
  if (queryTokens.length === 0) return true;
  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .join(' ')
    .toLowerCase();
  for (const token of queryTokens) {
    if (!haystack.includes(token)) return false;
  }
  return true;
}

export function filterDesignSystemInventory(
  raw: RawDesignSystemInventory,
  options: SearchDesignSystemOptions = {},
): FilteredDesignSystemInventory {
  const trimmedQuery = typeof options.query === 'string' ? options.query.trim() : '';
  const queryTokens = trimmedQuery
    ? trimmedQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
    : [];
  const limit =
    typeof options.limit === 'number' && options.limit > 0
      ? Math.min(200, Math.floor(options.limit))
      : 50;

  const includeComponents = options.includeComponents !== false;
  const includeStyles = options.includeStyles !== false;
  const includeVariables = options.includeVariables !== false;

  const out: FilteredDesignSystemInventory = {
    query: trimmedQuery || null,
    limit,
  };

  if (includeComponents) {
    const matched = raw.components.filter((c) => {
      const propText = c.properties
        .map((p) => `${p.name} ${(p.variantOptions ?? []).join(' ')}`)
        .join(' ');
      return matchesQuery(queryTokens, [c.name, c.description, c.type, propText]);
    });
    out.components = {
      total: matched.length,
      items: matched.slice(0, limit),
    };
  }

  if (includeStyles) {
    const textMatched = raw.styles.textStyles.filter((s) => matchesQuery(queryTokens, [s.name]));
    const paintMatched = raw.styles.paintStyles.filter((s) => matchesQuery(queryTokens, [s.name]));
    const effectMatched = raw.styles.effectStyles.filter((s) => matchesQuery(queryTokens, [s.name]));
    out.styles = {
      textStyles: textMatched.slice(0, limit),
      paintStyles: paintMatched.slice(0, limit),
      effectStyles: effectMatched.slice(0, limit),
      totals: {
        text: textMatched.length,
        paint: paintMatched.length,
        effect: effectMatched.length,
      },
    };
  }

  if (includeVariables) {
    const localVarsMatched = raw.localVariables.variables.filter((v) =>
      matchesQuery(queryTokens, [v.name, v.collectionName, v.resolvedType]),
    );
    const localCollectionIds = new Set(localVarsMatched.map((v) => v.collectionId));
    const localCollections = queryTokens.length === 0
      ? raw.localVariables.collections
      : raw.localVariables.collections.filter(
          (c) => localCollectionIds.has(c.id) || matchesQuery(queryTokens, [c.name]),
        );

    out.localVariables = {
      collections: localCollections.slice(0, limit),
      variables: localVarsMatched.slice(0, limit),
      totalVariables: localVarsMatched.length,
    };

    const libVarsMatched = raw.libraryVariables.variables.filter((v) =>
      matchesQuery(queryTokens, [v.name, v.collectionName, v.libraryName, v.resolvedType]),
    );
    const libCollectionKeys = new Set(libVarsMatched.map((v) => v.collectionKey));
    const libCollections = queryTokens.length === 0
      ? raw.libraryVariables.collections
      : raw.libraryVariables.collections.filter(
          (c) => libCollectionKeys.has(c.key) || matchesQuery(queryTokens, [c.name, c.libraryName]),
        );

    out.libraryVariables = {
      collections: libCollections.slice(0, limit),
      variables: libVarsMatched.slice(0, limit),
      totalVariables: libVarsMatched.length,
      ...(raw.libraryVariables.unavailableReason
        ? { unavailableReason: raw.libraryVariables.unavailableReason }
        : {}),
    };
  }

  return out;
}

// ─── 3. audit_frame Analysis Engine ───

export interface AuditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AuditNodeSnapshot {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  width: number;
  height: number;
  bounds?: AuditRect | null;
  clipsContent?: boolean;
  hasImageFill?: boolean;
  hasHardcodedSolidFill?: boolean;
  hasHardcodedTextStyle?: boolean;
  textTruncation?: string;
  textAutoResize?: string;
  fonts?: Array<{ family: string; style: string }>;
  isPlaceholder?: boolean;
  children?: AuditNodeSnapshot[];
}

export interface AuditFrameContext {
  hasLocalVariables: boolean;
  hasLocalPaintStyles: boolean;
  hasLocalTextStyles: boolean;
}

export interface AuditZeroSizeNode {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
}

export interface AuditClippedNode {
  id: string;
  name: string;
  type: string;
  reason: string;
  parentId?: string;
  parentName?: string;
}

export interface AuditImageNode {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  widthRatio: number;
  heightRatio: number;
  suspiciousFullFrameRaster: boolean;
}

export interface AuditPlaceholderNode {
  id: string;
  name: string;
  type: string;
}

export interface AuditFrameReport {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  width: number;
  height: number;
  descendantCounts: Record<string, number>;
  zeroSizeNodes: AuditZeroSizeNode[];
  clippedOrOverflowingNodes: AuditClippedNode[];
  imageNodes: AuditImageNode[];
  fontsUsed: Array<{ family: string; style: string }>;
  placeholderNodes: AuditPlaceholderNode[];
  unboundStyleWarnings: {
    hardcodedFillCount: number;
    hardcodedTextCount: number;
    hasLocalVariables: boolean;
    hasLocalStyles: boolean;
  };
  passed: boolean;
  issues: string[];
}

const OVERFLOW_TOLERANCE_PX = 1;
const FULL_FRAME_RASTER_THRESHOLD = 0.8;

export function analyzeAuditTree(
  root: AuditNodeSnapshot,
  context: AuditFrameContext,
): AuditFrameReport {
  const descendantCounts: Record<string, number> = {};
  const zeroSizeNodes: AuditZeroSizeNode[] = [];
  const clippedOrOverflowingNodes: AuditClippedNode[] = [];
  const imageNodes: AuditImageNode[] = [];
  const placeholderNodes: AuditPlaceholderNode[] = [];
  const fontMap = new Map<string, { family: string; style: string }>();

  let hardcodedFillCount = 0;
  let hardcodedTextCount = 0;

  const rootWidth = root.width > 0 ? root.width : 1;
  const rootHeight = root.height > 0 ? root.height : 1;

  function walk(node: AuditNodeSnapshot, isRoot: boolean, clippingParent?: AuditNodeSnapshot): void {
    if (!node.visible) return;

    if (!isRoot) {
      descendantCounts[node.type] = (descendantCounts[node.type] ?? 0) + 1;
    }

    if (node.width <= 0 || node.height <= 0) {
      zeroSizeNodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        width: node.width,
        height: node.height,
      });
    }

    if (node.isPlaceholder) {
      placeholderNodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
      });
    }

    if (!isRoot && clippingParent && clippingParent.bounds && node.bounds) {
      const p = clippingParent.bounds;
      const c = node.bounds;
      const overflowsLeft = c.x < p.x - OVERFLOW_TOLERANCE_PX;
      const overflowsTop = c.y < p.y - OVERFLOW_TOLERANCE_PX;
      const overflowsRight = c.x + c.width > p.x + p.width + OVERFLOW_TOLERANCE_PX;
      const overflowsBottom = c.y + c.height > p.y + p.height + OVERFLOW_TOLERANCE_PX;

      if (overflowsLeft || overflowsTop || overflowsRight || overflowsBottom) {
        const sides: string[] = [];
        if (overflowsLeft) sides.push('left');
        if (overflowsTop) sides.push('top');
        if (overflowsRight) sides.push('right');
        if (overflowsBottom) sides.push('bottom');
        clippedOrOverflowingNodes.push({
          id: node.id,
          name: node.name,
          type: node.type,
          reason: `Overflows clipping parent on ${sides.join(', ')}`,
          parentId: clippingParent.id,
          parentName: clippingParent.name,
        });
      }
    }

    if (node.type === 'TEXT') {
      if (node.textTruncation === 'ENDING' || node.textAutoResize === 'TRUNCATE') {
        clippedOrOverflowingNodes.push({
          id: node.id,
          name: node.name,
          type: node.type,
          reason: `Text is truncated (textTruncation=${node.textTruncation ?? 'NONE'}, textAutoResize=${node.textAutoResize ?? 'NONE'})`,
          ...(clippingParent ? { parentId: clippingParent.id, parentName: clippingParent.name } : {}),
        });
      }
    }

    if (node.hasImageFill) {
      const widthRatio = Number((node.width / rootWidth).toFixed(3));
      const heightRatio = Number((node.height / rootHeight).toFixed(3));
      const suspiciousFullFrameRaster =
        widthRatio >= FULL_FRAME_RASTER_THRESHOLD &&
        heightRatio >= FULL_FRAME_RASTER_THRESHOLD;
      imageNodes.push({
        id: node.id,
        name: node.name,
        type: node.type,
        width: node.width,
        height: node.height,
        widthRatio,
        heightRatio,
        suspiciousFullFrameRaster,
      });
    }

    if (node.fonts) {
      for (const f of node.fonts) {
        const key = `${f.family}\u0000${f.style}`;
        if (!fontMap.has(key)) {
          fontMap.set(key, { family: f.family, style: f.style });
        }
      }
    }

    if (node.hasHardcodedSolidFill && (context.hasLocalVariables || context.hasLocalPaintStyles)) {
      hardcodedFillCount++;
    }
    if (node.hasHardcodedTextStyle && context.hasLocalTextStyles) {
      hardcodedTextCount++;
    }

    const nextClippingParent = node.clipsContent && node.bounds ? node : clippingParent;
    if (node.children) {
      for (const child of node.children) {
        walk(child, false, nextClippingParent);
      }
    }
  }

  walk(root, true, undefined);

  const issues: string[] = [];
  if (zeroSizeNodes.length > 0) {
    issues.push(
      `${zeroSizeNodes.length} zero-size node(s) detected (e.g. ${zeroSizeNodes
        .slice(0, 3)
        .map((n) => `${n.name} [${n.id}]`)
        .join(', ')}).`,
    );
  }
  if (clippedOrOverflowingNodes.length > 0) {
    issues.push(
      `${clippedOrOverflowingNodes.length} clipped or overflowing node(s) detected (e.g. ${clippedOrOverflowingNodes
        .slice(0, 3)
        .map((n) => `${n.name} [${n.id}]: ${n.reason}`)
        .join('; ')}).`,
    );
  }
  const suspiciousRasters = imageNodes.filter((n) => n.suspiciousFullFrameRaster);
  if (suspiciousRasters.length > 0) {
    issues.push(
      `${suspiciousRasters.length} suspicious full-frame raster image node(s) >= 80% of root dimensions (${suspiciousRasters
        .map((n) => `${n.name} [${n.id}]`)
        .join(', ')}). Verify no reference screenshot was embedded.`,
    );
  }
  if (placeholderNodes.length > 0) {
    issues.push(
      `${placeholderNodes.length} unfinished placeholder section(s) remaining (${placeholderNodes
        .map((n) => `${n.name} [${n.id}]`)
        .join(', ')}).`,
    );
  }

  const hasLocalStyles = context.hasLocalPaintStyles || context.hasLocalTextStyles;
  if (hardcodedFillCount > 0 || hardcodedTextCount > 0) {
    issues.push(
      `Unbound styling detected while local tokens exist: ${hardcodedFillCount} hardcoded fill(s), ${hardcodedTextCount} hardcoded text node(s).`,
    );
  }

  const hasBlockingIssues =
    zeroSizeNodes.length > 0 ||
    clippedOrOverflowingNodes.length > 0 ||
    suspiciousRasters.length > 0 ||
    placeholderNodes.length > 0;

  return {
    nodeId: root.id,
    nodeName: root.name,
    nodeType: root.type,
    width: root.width,
    height: root.height,
    descendantCounts,
    zeroSizeNodes,
    clippedOrOverflowingNodes,
    imageNodes,
    fontsUsed: Array.from(fontMap.values()),
    placeholderNodes,
    unboundStyleWarnings: {
      hardcodedFillCount,
      hardcodedTextCount,
      hasLocalVariables: context.hasLocalVariables,
      hasLocalStyles,
    },
    passed: !hasBlockingIssues,
    issues,
  };
}

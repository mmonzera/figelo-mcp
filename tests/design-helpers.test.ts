import { describe, expect, it } from 'vitest';
import {
  analyzeAuditTree,
  classifyExecuteJsFailure,
  evaluateExecuteJsTimeoutWarning,
  filterDesignSystemInventory,
  type AuditNodeSnapshot,
  type CanvasSnapshot,
  type RawDesignSystemInventory,
} from '../src/shared/design-helpers.js';

describe('search_design_system filtering', () => {
  const sampleInventory: RawDesignSystemInventory = {
    components: [
      {
        id: '10:1',
        key: 'comp-btn',
        name: 'Button / Primary',
        type: 'COMPONENT_SET',
        description: 'Action CTA button',
        properties: [
          { name: 'Size', type: 'VARIANT', variantOptions: ['sm', 'md', 'lg'] },
          { name: 'Label', type: 'TEXT', defaultValue: 'Submit' },
          { name: 'Disabled', type: 'BOOLEAN', defaultValue: false },
        ],
      },
      {
        id: '10:2',
        key: 'comp-card',
        name: 'Card / Metric',
        type: 'COMPONENT',
        description: 'KPI summary card',
        properties: [],
      },
    ],
    styles: {
      textStyles: [
        { id: 'S:1', key: 'ts-1', name: 'Heading / H1' },
        { id: 'S:2', key: 'ts-2', name: 'Body / Regular' },
      ],
      paintStyles: [
        { id: 'S:3', key: 'ps-1', name: 'Brand / Primary Blue' },
        { id: 'S:4', key: 'ps-2', name: 'Surface / Card' },
      ],
      effectStyles: [{ id: 'S:5', key: 'es-1', name: 'Shadow / Elevated' }],
    },
    localVariables: {
      collections: [
        {
          id: 'VC:1',
          name: 'Colors',
          modes: [
            { modeId: 'm1', name: 'Light' },
            { modeId: 'm2', name: 'Dark' },
          ],
          variableCount: 2,
        },
      ],
      variables: [
        {
          id: 'V:1',
          name: 'color/brand/primary',
          resolvedType: 'COLOR',
          collectionId: 'VC:1',
          collectionName: 'Colors',
        },
        {
          id: 'V:2',
          name: 'color/surface/card',
          resolvedType: 'COLOR',
          collectionId: 'VC:1',
          collectionName: 'Colors',
        },
      ],
    },
    libraryVariables: {
      collections: [{ key: 'lib-col-1', name: 'Tokens', libraryName: 'Acme Design System' }],
      variables: [
        {
          key: 'lib-var-1',
          name: 'spacing/md',
          resolvedType: 'FLOAT',
          collectionKey: 'lib-col-1',
          collectionName: 'Tokens',
          libraryName: 'Acme Design System',
        },
        {
          key: 'lib-var-2',
          name: 'color/brand/primary',
          resolvedType: 'COLOR',
          collectionKey: 'lib-col-1',
          collectionName: 'Tokens',
          libraryName: 'Acme Design System',
        },
      ],
    },
  };

  it('filters case-insensitively across components, styles, local variables, and library variables', () => {
    const res = filterDesignSystemInventory(sampleInventory, { query: 'PRIMARY' });

    expect(res.query).toBe('PRIMARY');
    expect(res.components?.items.map((c) => c.id)).toEqual(['10:1']);
    expect(res.styles?.paintStyles.map((s) => s.id)).toEqual(['S:3']);
    expect(res.styles?.textStyles).toHaveLength(0);
    expect(res.localVariables?.variables.map((v) => v.id)).toEqual(['V:1']);
    expect(res.libraryVariables?.variables.map((v) => v.key)).toEqual(['lib-var-2']);
  });

  it('matches component variant options and respects category toggles and limit', () => {
    const byVariant = filterDesignSystemInventory(sampleInventory, {
      query: 'lg',
      includeStyles: false,
      includeVariables: false,
    });
    expect(byVariant.components?.items.map((c) => c.id)).toEqual(['10:1']);
    expect(byVariant.styles).toBeUndefined();
    expect(byVariant.localVariables).toBeUndefined();
    expect(byVariant.libraryVariables).toBeUndefined();

    const limited = filterDesignSystemInventory(sampleInventory, { limit: 1 });
    expect(limited.components?.total).toBe(2);
    expect(limited.components?.items).toHaveLength(1);
    expect(limited.localVariables?.totalVariables).toBe(2);
    expect(limited.localVariables?.variables).toHaveLength(1);
  });

  it('preserves team library unavailableReason gracefully', () => {
    const withReason: RawDesignSystemInventory = {
      ...sampleInventory,
      libraryVariables: {
        collections: [],
        variables: [],
        unavailableReason: 'Permission denied',
      },
    };
    const res = filterDesignSystemInventory(withReason);
    expect(res.libraryVariables?.unavailableReason).toBe('Permission denied');
    expect(res.libraryVariables?.variables).toEqual([]);
  });
});

describe('audit_frame issue detection', () => {
  it('passes a clean frame and reports descendant counts and distinct fonts', () => {
    const cleanTree: AuditNodeSnapshot = {
      id: '1:1',
      name: 'Landing Wrapper',
      type: 'FRAME',
      visible: true,
      width: 1200,
      height: 800,
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      clipsContent: true,
      children: [
        {
          id: '1:2',
          name: 'Title',
          type: 'TEXT',
          visible: true,
          width: 400,
          height: 48,
          bounds: { x: 40, y: 40, width: 400, height: 48 },
          fonts: [{ family: 'Plus Jakarta Sans', style: 'Bold' }],
        },
        {
          id: '1:3',
          name: 'Subtitle',
          type: 'TEXT',
          visible: true,
          width: 400,
          height: 24,
          bounds: { x: 40, y: 100, width: 400, height: 24 },
          fonts: [{ family: 'Plus Jakarta Sans', style: 'Bold' }],
        },
        {
          id: '1:4',
          name: 'Avatar',
          type: 'ELLIPSE',
          visible: true,
          width: 64,
          height: 64,
          bounds: { x: 40, y: 140, width: 64, height: 64 },
          hasImageFill: true,
        },
      ],
    };

    const report = analyzeAuditTree(cleanTree, {
      hasLocalVariables: false,
      hasLocalPaintStyles: false,
      hasLocalTextStyles: false,
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.descendantCounts).toEqual({ TEXT: 2, ELLIPSE: 1 });
    expect(report.fontsUsed).toEqual([{ family: 'Plus Jakarta Sans', style: 'Bold' }]);
    expect(report.imageNodes).toHaveLength(1);
    expect(report.imageNodes[0].suspiciousFullFrameRaster).toBe(false);
  });

  it('detects zero-size, clipped/overflowing, truncated text, full-frame raster, placeholder, and unbound styles', () => {
    const brokenTree: AuditNodeSnapshot = {
      id: '2:1',
      name: 'Screen',
      type: 'FRAME',
      visible: true,
      width: 1000,
      height: 800,
      bounds: { x: 0, y: 0, width: 1000, height: 800 },
      clipsContent: true,
      children: [
        {
          id: '2:2',
          name: 'Empty Box',
          type: 'RECTANGLE',
          visible: true,
          width: 0,
          height: 40,
          bounds: { x: 10, y: 10, width: 0, height: 40 },
          hasHardcodedSolidFill: true,
        },
        {
          id: '2:3',
          name: 'Overflowing Card',
          type: 'FRAME',
          visible: true,
          width: 300,
          height: 200,
          bounds: { x: 850, y: 50, width: 300, height: 200 },
        },
        {
          id: '2:4',
          name: 'Clipped Label',
          type: 'TEXT',
          visible: true,
          width: 120,
          height: 20,
          bounds: { x: 20, y: 100, width: 120, height: 20 },
          textTruncation: 'ENDING',
          hasHardcodedTextStyle: true,
          fonts: [{ family: 'Inter', style: 'Regular' }],
        },
        {
          id: '2:5',
          name: 'Accidental Reference Screenshot',
          type: 'RECTANGLE',
          visible: true,
          width: 950,
          height: 760,
          bounds: { x: 0, y: 0, width: 950, height: 760 },
          hasImageFill: true,
        },
        {
          id: '2:6',
          name: 'Pricing Placeholder',
          type: 'FRAME',
          visible: true,
          width: 400,
          height: 200,
          bounds: { x: 20, y: 300, width: 400, height: 200 },
          isPlaceholder: true,
        },
        {
          id: '2:7',
          name: 'Hidden Helper',
          type: 'FRAME',
          visible: false,
          width: 0,
          height: 0,
        },
      ],
    };

    const report = analyzeAuditTree(brokenTree, {
      hasLocalVariables: true,
      hasLocalPaintStyles: false,
      hasLocalTextStyles: true,
    });

    expect(report.passed).toBe(false);
    expect(report.zeroSizeNodes.map((n) => n.id)).toEqual(['2:2']);
    expect(report.clippedOrOverflowingNodes.map((n) => n.id)).toEqual(['2:3', '2:4']);
    expect(report.imageNodes).toHaveLength(1);
    expect(report.imageNodes[0].suspiciousFullFrameRaster).toBe(true);
    expect(report.placeholderNodes.map((n) => n.id)).toEqual(['2:6']);
    expect(report.unboundStyleWarnings).toEqual({
      hardcodedFillCount: 1,
      hardcodedTextCount: 1,
      hasLocalVariables: true,
      hasLocalStyles: true,
    });
    expect(report.issues.length).toBeGreaterThanOrEqual(5);
  });
});

describe('execute_figma_js retry-safety classification', () => {
  const baseSnapshot: CanvasSnapshot = {
    currentPageId: '0:1',
    pageIds: ['0:1'],
    nodes: {
      '0:1': { id: '0:1', name: 'Page 1', type: 'PAGE', parentId: null, childIds: ['1:1'] },
      '1:1': {
        id: '1:1',
        name: 'Existing Frame',
        type: 'FRAME',
        parentId: '0:1',
        childIds: [],
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        visible: true,
      },
    },
  };

  it('marks pre-mutation errors as safeToRetryWithoutCanvasRead: true', () => {
    const res = classifyExecuteJsFailure({
      error: new SyntaxError('Unexpected token'),
      beforeSnapshot: baseSnapshot,
      afterSnapshot: baseSnapshot,
      trackedCreatedIds: [],
      trackedMutated: false,
      elapsedMs: 120,
    });

    expect(res).toEqual({
      ok: false,
      error: 'Unexpected token',
      safeToRetryWithoutCanvasRead: true,
      createdNodeIds: [],
    });
  });

  it('marks partial node creation as safeToRetryWithoutCanvasRead: false with createdNodeIds', () => {
    const afterSnapshot: CanvasSnapshot = {
      currentPageId: '0:1',
      pageIds: ['0:1'],
      nodes: {
        ...baseSnapshot.nodes,
        '0:1': {
          id: '0:1',
          name: 'Page 1',
          type: 'PAGE',
          parentId: null,
          childIds: ['1:1', '1:2'],
        },
        '1:2': {
          id: '1:2',
          name: 'Partial Wrapper',
          type: 'FRAME',
          parentId: '0:1',
          childIds: [],
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          visible: true,
        },
      },
    };

    const res = classifyExecuteJsFailure({
      error: new Error('Font not loaded'),
      beforeSnapshot: baseSnapshot,
      afterSnapshot,
      trackedCreatedIds: ['1:2', '1:3'],
      trackedMutated: true,
      elapsedMs: 35_000,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('Font not loaded');
    expect(res.safeToRetryWithoutCanvasRead).toBe(false);
    expect(res.createdNodeIds).toEqual(['1:2', '1:3']);
    expect(res.warning).toContain('35000ms');
  });

  it('marks in-place mutation of an existing node as unsafe to retry blindly', () => {
    const afterSnapshot: CanvasSnapshot = {
      currentPageId: '0:1',
      pageIds: ['0:1'],
      nodes: {
        ...baseSnapshot.nodes,
        '1:1': {
          ...baseSnapshot.nodes['1:1'],
          x: 200,
        },
      },
    };

    const res = classifyExecuteJsFailure({
      error: new Error('Failed halfway'),
      beforeSnapshot: baseSnapshot,
      afterSnapshot,
      trackedCreatedIds: [],
      trackedMutated: false,
    });

    expect(res.safeToRetryWithoutCanvasRead).toBe(false);
    expect(res.createdNodeIds).toEqual([]);
  });

  it('emits a soft timeout warning only when elapsedMs reaches threshold', () => {
    expect(evaluateExecuteJsTimeoutWarning(5_000, 45_000, 30_000)).toBeUndefined();
    expect(evaluateExecuteJsTimeoutWarning(32_500, 45_000, 30_000)).toContain('32500ms');
  });
});

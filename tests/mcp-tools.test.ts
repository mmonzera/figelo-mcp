import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  executeToolWithBroker,
  FIGELO_MCP_INSTRUCTIONS,
  formatMcpToolResult,
  TOOL_DEFINITIONS,
} from '../src/hub/mcp-tools.js';
import type { PluginBroker } from '../src/hub/plugin-broker.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'figelo-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('FigeloMCP upgraded tool suite', () => {
  it('registers all 38 tools with unique names and valid Zod schemas', () => {
    expect(TOOL_DEFINITIONS.length).toBe(38);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(38);

    const expectedNewTools = [
      'get_design_context',
      'get_screenshot',
      'create_variable_collection',
      'create_variable',
      'set_variable_value',
      'bind_variable',
      'create_component_set',
      'create_section',
      'set_image_fill',
      'clone_node',
      'group_nodes',
      'create_page',
      'batch_create',
      'search_design_system',
      'audit_frame',
    ];
    for (const name of expectedNewTools) {
      expect(names).toContain(name);
    }

    for (const def of TOOL_DEFINITIONS) {
      expect(() => z.object(def.shape)).not.toThrow();
    }
  });

  it('includes the Design Agent SOP in MCP server instructions', () => {
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('list_figma_documents');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('search_design_system');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('audit_frame');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('get_screenshot');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('execute_figma_js');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('loadFontAsync');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('figma.notify()');
    expect(FIGELO_MCP_INSTRUCTIONS).toContain('safeToRetryWithoutCanvasRead');
  });

  it('validates search_design_system, audit_frame, and placeholder schemas', () => {
    const searchDef = TOOL_DEFINITIONS.find((t) => t.name === 'search_design_system')!;
    const searchSchema = z.object(searchDef.shape);
    expect(
      searchSchema.parse({
        query: 'button',
        includeVariables: true,
        includeStyles: false,
        includeComponents: true,
        limit: 25,
      }),
    ).toEqual({
      query: 'button',
      includeVariables: true,
      includeStyles: false,
      includeComponents: true,
      limit: 25,
    });

    const auditDef = TOOL_DEFINITIONS.find((t) => t.name === 'audit_frame')!;
    const auditSchema = z.object(auditDef.shape);
    expect(auditSchema.parse({ nodeId: '12:34' })).toEqual({ nodeId: '12:34' });
    expect(() => auditSchema.parse({})).toThrow();

    const createFrameDef = TOOL_DEFINITIONS.find((t) => t.name === 'create_frame')!;
    expect(z.object(createFrameDef.shape).parse({ name: 'Hero', placeholder: true })).toMatchObject({
      name: 'Hero',
      placeholder: true,
    });

    const updateNodeDef = TOOL_DEFINITIONS.find((t) => t.name === 'update_node')!;
    expect(
      z.object(updateNodeDef.shape).parse({ nodeId: '1:2', placeholder: false }),
    ).toMatchObject({
      nodeId: '1:2',
      placeholder: false,
    });
  });

  it('formatMcpToolResult emits native image blocks for get_screenshot and get_design_context without raw base64 in text', () => {
    const ssRes = formatMcpToolResult('get_screenshot', {
      nodeId: '1:2',
      nodeName: 'Card',
      format: 'PNG',
      mimeType: 'image/png',
      byteLength: 4,
      base64: 'AQIDBA==',
    });
    expect(ssRes.content).toHaveLength(2);
    expect(ssRes.content[0].type).toBe('text');
    expect((ssRes.content[0] as { text: string }).text).not.toContain('AQIDBA==');
    expect(ssRes.content[1]).toEqual({
      type: 'image',
      data: 'AQIDBA==',
      mimeType: 'image/png',
    });

    const dcRes = formatMcpToolResult('get_design_context', {
      node: { id: '1:2', name: 'Card', type: 'FRAME' },
      summary: { colors: ['#ffffff'], fonts: ['Inter Regular'], boundVariableIds: [] },
      screenshot: {
        mimeType: 'image/png',
        byteLength: 4,
        base64: 'Zm9v',
      },
    });
    expect(dcRes.content).toHaveLength(2);
    expect((dcRes.content[0] as { text: string }).text).not.toContain('Zm9v');
    expect(dcRes.content[1]).toEqual({
      type: 'image',
      data: 'Zm9v',
      mimeType: 'image/png',
    });
  });

  it('set_image_fill reads a local filePath and forwards base64 bytes to the plugin broker', async () => {
    const dir = makeTempDir();
    const imgPath = join(dir, 'sample.png');
    const sampleBytes = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
    writeFileSync(imgPath, sampleBytes);

    const callPlugin = vi.fn().mockResolvedValue({
      nodeId: '10:20',
      imageHash: 'hash-123',
      scaleMode: 'FILL',
    });
    const fakeBroker = { callPlugin } as unknown as PluginBroker;

    const result = await executeToolWithBroker(fakeBroker, 'set_image_fill', {
      nodeId: '10:20',
      filePath: imgPath,
      scaleMode: 'FIT',
    });

    expect(callPlugin).toHaveBeenCalledTimes(1);
    expect(callPlugin).toHaveBeenCalledWith(
      'set_image_fill',
      {
        nodeId: '10:20',
        imageBase64: sampleBytes.toString('base64'),
        scaleMode: 'FIT',
      },
      { channel: undefined, timeoutMs: 45_000 },
    );
    expect(result).toEqual({
      nodeId: '10:20',
      imageHash: 'hash-123',
      scaleMode: 'FILL',
    });
  });
});

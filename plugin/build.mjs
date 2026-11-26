import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(here, 'dist');
mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [resolve(here, 'src', 'code.ts')],
  outfile: resolve(distDir, 'code.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2017',
  format: 'iife',
  logLevel: 'info',
});

copyFileSync(resolve(here, 'src', 'ui.html'), resolve(distDir, 'ui.html'));
console.log('[FigeloMCP plugin] built plugin/dist/code.js and plugin/dist/ui.html');

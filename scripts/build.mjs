#!/usr/bin/env node
/**
 * Operator build: bundle the relay worker to a single self-contained
 * worker.js (for Cloudflare dashboard paste-deploys), and assemble dist/
 * (the static operator UI) for static hosting.
 *
 *   npm run build
 *
 * `wrangler deploy` does NOT need this script — wrangler bundles
 * src/index.ts itself. This script exists for the dashboard paste flow and
 * for static preview hosting.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// 1. Bundle the worker (plain JS shared/ modules are imported as ESM).
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'worker.js',
  platform: 'neutral',
  target: 'es2020',
  format: 'esm',
  minify: false,
  keepNames: true,
  external: ['node:*', 'cloudflare:*'],
  logLevel: 'info',
});

// 2. Static UI into dist/.
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const item of ['index.html', 'favicon.svg', 'ui', 'shared', 'docs', 'images', 'nostr-zap.js', 'README.md', 'UPSTREAM.md']) {
  if (existsSync(item)) {
    await cp(item, `dist/${item}`, { recursive: true });
  }
}

console.log('\nBuilt worker.js (relay bundle) and dist/ (static operator UI).');

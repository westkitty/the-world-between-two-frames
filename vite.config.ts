import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Served from https://westkitty.github.io/the-world-between-two-frames/ by default.
// Override with TWBTF_BASE (for example TWBTF_BASE=/ for a root-hosted copy).
const base = process.env.TWBTF_BASE ?? '/the-world-between-two-frames/';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * After the build (including the copied public/ folder) is written, generate
 * dist/sw.js from pwa/sw.js: precache every shipped file except source maps,
 * and stamp a cache version derived from the content hash so each changed
 * build installs a fresh cache and evicts the old one.
 */
function serviceWorkerPrecache(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'twbtf-service-worker-precache',
    apply: 'build',
    configResolved(resolved) { config = resolved; },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const files = listFiles(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        .filter((file) => !file.endsWith('.map') && file !== 'sw.js')
        .sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update(readFileSync(join(outDir, file)));
      const version = hash.digest('hex').slice(0, 12);
      const precache = ['./', ...files.filter((file) => file !== 'index.html'), 'index.html'];
      const template = readFileSync(resolve(config.root, 'pwa/sw.js'), 'utf8');
      const output = template
        .replace('__CACHE_VERSION__', version)
        .replace('__BUILD_TIME__', new Date().toISOString())
        .replace('__PRECACHE__', JSON.stringify(precache, null, 2));
      writeFileSync(join(outDir, 'sw.js'), output);
      writeFileSync(join(outDir, 'version.json'), JSON.stringify({ cache: version, files: precache.length }, null, 2));
      config.logger.info(`service worker: cache twbtf-${version}, ${precache.length} precached entries`);
    },
  };
}

export default defineConfig({
  base,
  plugins: [serviceWorkerPrecache()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    // The Three.js engine bundle is intentionally kept intact (~155 KB gzip).
    chunkSizeWarningLimit: 650,
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});

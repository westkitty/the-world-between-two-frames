// Installability + offline check for a served build.
//   PWA_URL=http://127.0.0.1:4173/the-world-between-two-frames/ node scripts/pwa-check.mjs
// Optional: SHOT=path.png (1480x924 tablet screenshot), SHOT_NARROW=path.png (924x1480).
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.PWA_URL ?? 'https://westkitty.github.io/the-world-between-two-frames/';
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const context = await browser.newContext({ viewport: { width: 1480, height: 924 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', (request) => { if (process.env.PWA_DEBUG) console.log('requestfailed', request.url(), request.failure()?.errorText); });
  const response = await page.goto(url, { waitUntil: 'load' });
  assert.equal(response?.status(), 200, 'page should return 200');
  await page.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'), null, { timeout: 30000 });

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifestUrl = new URL(manifestHref, url).href;
  const manifestRes = await page.request.get(manifestUrl);
  assert.equal(manifestRes.status(), 200, 'manifest should return 200');
  const manifest = JSON.parse(await manifestRes.text());
  const scopeUrl = new URL(manifest.scope, manifestUrl).href;
  assert.equal(manifest.display, 'fullscreen');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
  assert.ok(url.startsWith(scopeUrl), `page ${url} should be inside scope ${scopeUrl}`);
  assert.equal(new URL(manifest.start_url, manifestUrl).href, scopeUrl, 'start_url should equal scope');
  for (const icon of manifest.icons.concat(manifest.screenshots)) {
    const res = await page.request.get(new URL(icon.src, manifestUrl).href);
    assert.equal(res.status(), 200, `${icon.src} should return 200`);
    assert.match(res.headers()['content-type'] ?? '', /^image\/(png|jpeg)/, `${icon.src} should be an image, not an HTML fallback`);
  }
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(manifest.screenshots.some((s) => s.form_factor === 'wide') && manifest.screenshots.some((s) => s.form_factor === 'narrow'));
  console.log(`PASS · manifest parses (id ${new URL(manifest.id, manifestUrl).pathname}, scope ${new URL(scopeUrl).pathname}, ${manifest.icons.length} icons, ${manifest.screenshots.length} screenshots)`);

  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload({ waitUntil: 'load' });
  }
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    const cached = keys.length ? (await (await caches.open(keys[0])).keys()).length : 0;
    return { controlled: Boolean(navigator.serviceWorker.controller), scope: reg?.scope, script: reg?.active?.scriptURL, keys, cached };
  });
  assert.ok(sw.controlled, 'service worker should control the page');
  console.log(`PASS · service worker controls the page (scope ${sw.scope}, cache ${sw.keys.join(',')}, ${sw.cached} entries)`);

  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  const { url: cdpManifestUrl, errors: manifestErrors } = await cdp.send('Page.getAppManifest');
  assert.deepEqual(installabilityErrors, [], `installability errors: ${JSON.stringify(installabilityErrors)}`);
  assert.deepEqual(manifestErrors.filter((e) => e.critical), [], `manifest errors: ${JSON.stringify(manifestErrors)}`);
  console.log(`PASS · Chromium installability check: 0 errors (manifest ${cdpManifestUrl}; non-critical warnings: ${manifestErrors.length})`);

  if (process.env.SHOT) { await page.waitForTimeout(800); await page.screenshot({ path: process.env.SHOT }); console.log(`screenshot · ${process.env.SHOT}`); }

  await context.setOffline(true);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'), null, { timeout: 30000 });
  const offline = await page.evaluate(() => ({
    title: document.querySelector('#sceneTitle')?.textContent,
    thumbs: document.querySelectorAll('.scene-thumb').length,
    status: document.querySelector('#statusText')?.textContent ?? '',
    canvas: document.querySelector('#worldCanvas')?.width ?? 0,
  }));
  assert.equal(offline.title, 'The World Between Two Frames');
  assert.equal(offline.thumbs, 3, 'all three artworks should load offline');
  assert.ok(offline.canvas > 0);
  await page.locator('#depthSlider').fill('60');
  await page.waitForFunction(() => !document.querySelector('#enterButton')?.hasAttribute('disabled'));
  console.log('PASS · offline reload: app shell, three artworks and depth peel work with the network off');
  await context.setOffline(false);
  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED/.test(e)), [], 'no runtime/console errors');
  console.log('PASS · no runtime or console errors');
  await context.close();

  if (process.env.SHOT_NARROW) {
    const narrow = await browser.newContext({ viewport: { width: 924, height: 1480 }, deviceScaleFactor: 1, hasTouch: true });
    const p = await narrow.newPage();
    await p.goto(url, { waitUntil: 'load' });
    await p.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'), null, { timeout: 30000 });
    await p.waitForTimeout(800);
    await p.screenshot({ path: process.env.SHOT_NARROW });
    console.log(`screenshot · ${process.env.SHOT_NARROW}`);
    await narrow.close();
  }
} finally {
  await browser.close();
}

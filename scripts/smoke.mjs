import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { deflateSync } from 'node:zlib';

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum & 1) ? (checksum >>> 1) ^ 0xedb88320 : checksum >>> 1;
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
function makeTransparentPng() {
  const width = 320;
  const height = 180;
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    pixels[row] = 0; // PNG filter: None
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const transparent = x >= 100 && x < 220 && y >= 50 && y < 130;
      pixels[offset] = transparent ? 0 : 208;
      pixels[offset + 1] = transparent ? 0 : 64;
      pixels[offset + 2] = transparent ? 0 : 48;
      pixels[offset + 3] = transparent ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// SMOKE_URL runs the same journey against an already-served copy (e.g. the live Pages site).
const liveUrl = process.env.SMOKE_URL;
const server = liveUrl ? null : await createServer({
  configFile: './vite.config.ts',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error',
});
let browser;
try {
  let base;
  if (server) {
    await server.listen();
    const address = server.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 5173;
    base = `http://127.0.0.1:${port}${server.config.base}`;
  } else {
    base = `${liveUrl}${liveUrl.includes('?') ? '&' : '?'}wbtf-debug`;
  }
  console.log(`smoke target: ${base}`);
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1, reducedMotion: 'reduce', acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(message.text()); });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'));
  assert.match(await page.locator('#modeLabel').innerText(), /FLAT IMAGE/);
  assert.equal(await page.locator('#sceneTitle').innerText(), 'The World Between Two Frames');
  assert.equal(await page.locator('.scene-thumb').count(), 3);
  console.log('PASS · initial source image loads flat with three authored scenes');
  const frameBounds = await page.locator('#frameOutline').boundingBox();
  assert.ok(frameBounds, 'frame edge should be measurable');
  await page.mouse.move(frameBounds.x + frameBounds.width - 2, frameBounds.y + frameBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(frameBounds.x + frameBounds.width - 272, frameBounds.y + frameBounds.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.ok(Number(await page.locator('#depthSlider').inputValue()) >= 24, 'dragging inward from the frame edge should reveal enough depth to enter');
  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  console.log('PASS · the visible frame-edge grip directly controls the depth peel');
  await page.locator('#gpuButton').click();

  await page.evaluate(() => { window.__WBTF_FIRST_THUMB = document.querySelector('.scene-thumb'); });
  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '68';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => document.querySelector('.scene-thumb') === window.__WBTF_FIRST_THUMB), true, 'dragging depth should not rebuild unrelated scene-rail DOM');
  assert.match(await page.locator('#modeLabel').innerText(), /PEEL/);
  assert.equal(await page.locator('#enterButton').isEnabled(), true);
  await page.locator('#enterButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'EXPLORATION', null, { timeout: 12000 });
  assert.equal(await page.locator('#exploreHud').evaluate((node) => node.classList.contains('visible')), true);
  console.log('PASS · controlled depth peel and camera entry reach EXPLORE');

  await page.locator('#layersButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'FLAT IMAGE'
    && document.querySelector('#editorShell')?.classList.contains('open'));
  assert.equal(await page.locator('#editorPanel').isVisible(), true, 'opening the layer editor from Explore should reveal its controls');
  assert.equal(await page.locator('#editorShell').getAttribute('aria-hidden'), 'false');
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(120);
  const editorResize = await page.evaluate(() => {
    const frame = document.querySelector('#frameOutline').getBoundingClientRect();
    const mask = document.querySelector('#maskCanvas').getBoundingClientRect();
    return Math.max(Math.abs(frame.x - mask.x), Math.abs(frame.y - mask.y), Math.abs(frame.width - mask.width), Math.abs(frame.height - mask.height));
  });
  assert.ok(editorResize < 1, 'mask canvas should remain aligned to the artwork after a viewport resize');
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(120);
  await page.locator('#closeEditor').click();
  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '68';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#enterButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'EXPLORATION', null, { timeout: 12000 });
  console.log('PASS · layer editor opens visibly from Explore and returns to the original frame');

  for (let step = 0; step < 8; step += 1) await page.locator('#moveRight').click();
  for (let step = 0; step < 7; step += 1) await page.locator('#moveForward').click();
  assert.match(await page.locator('#fieldPosition').textContent(), /4\.52 \/ 2\.40/);
  await page.mouse.click(580, 362);
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'EXPLORATION'
    && document.querySelector('#sceneTitle')?.textContent === 'The Glass Orchard', null, { timeout: 14000 });
  console.log('PASS · moving to and raycasting the visible scene-space aperture crosses into its destination');

  await page.locator('#approachPortal').click();
  await page.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'The Glass Orchard', null, { timeout: 14000 });
  await page.locator('#approachPortal').click();
  await page.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'The Quiet Engine', null, { timeout: 14000 });
  await page.locator('#approachPrevious').click();
  await page.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'The Glass Orchard', null, { timeout: 14000 });
  console.log('PASS · two scene-space portal crossings and a reverse crossing');

  await page.locator('#returnButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'PEEL / DEPTH', null, { timeout: 12000 });
  await page.locator('#resetButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'FLAT IMAGE', null, { timeout: 12000 });
  console.log('PASS · smooth return and original flat frame reset');

  await page.locator('#fullscreenButton').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement), null, { timeout: 12000 });
  await page.locator('#fullscreenButton').click();
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 12000 });
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.waitForTimeout(120);
  const resizedStage = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    canvasWidth: document.querySelector('#worldCanvas').width,
    canvasHeight: document.querySelector('#worldCanvas').height,
    frame: document.querySelector('#frameOutline').getBoundingClientRect().toJSON(),
  }));
  assert.ok(resizedStage.canvasWidth > 0 && resizedStage.canvasHeight > 0, 'renderer should retain a non-zero drawing buffer after resize/fullscreen');
  assert.ok(resizedStage.frame.width > 0 && resizedStage.frame.width < resizedStage.width);
  await page.setViewportSize({ width: 960, height: 600 });
  await page.waitForTimeout(120);
  console.log('PASS · fullscreen exit and repeated viewport resize keep the stage drawable');

  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '58';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#enterButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'EXPLORATION', null, { timeout: 12000 });
  await page.locator('#moreButton').click();
  await page.locator('#reducedMotionToggle').uncheck();
  await page.locator('#returnButton').click();
  await page.locator('#moreButton').click();
  await page.locator('#reducedMotionToggle').check();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'PEEL / DEPTH', null, { timeout: 12000 });
  assert.equal(await page.evaluate(() => window.__WBTF_DEBUG__().busy), false, 'finishing a camera tween in reduced-motion mode should release camera ownership');
  await page.locator('#resetButton').click();
  await page.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'FLAT IMAGE', null, { timeout: 12000 });
  console.log('PASS · reduced-motion toggle completes the active camera transition without stranding the mode');

  const source = await readFile('public/artwork/file_00000000f77881f5987cd6d628ca6347.png');
  await page.locator('#imageInput').setInputFiles({ name: 'smoke-import.png', mimeType: 'image/png', buffer: source });
  await page.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'Smoke Import', null, { timeout: 12000 });
  await page.locator('#layersButton').click();
  await page.locator('#startMaskButton').click();
  const bounds = await page.locator('#maskCanvas').boundingBox();
  assert.ok(bounds && bounds.width > 200 && bounds.height > 100, 'mask canvas should align to the visible image frame');
  for (const [x, y] of [[0.22, 0.28], [0.48, 0.2], [0.56, 0.57], [0.25, 0.63]]) {
    await page.locator('#maskCanvas').click({ position: { x: bounds.width * x, y: bounds.height * y } });
  }
  await page.locator('#startMaskButton').click();
  await page.locator('#roleSelect').selectOption('subject');
  await page.locator('#saveMaskButton').click();
  await page.waitForFunction(() => document.querySelector('#layerCountLabel')?.textContent === '06');
  await page.locator('#editorLayerList .editor-layer-row').first().locator('.delete-layer').click();
  assert.equal(await page.locator('#layerCountLabel').textContent(), '06', 'the final full-source plane should not be removable');
  await page.locator('#closeEditor').click();
  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '64';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await page.locator('#modeLabel').innerText(), 'PEEL / DEPTH');
  assert.equal(await page.locator('#layerLegendList li').count(), 6, 'saved polygon should participate as a sixth separated plane');
  await page.locator('#depthSlider').evaluate((element) => {
    element.value = '0';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(800);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'));
  assert.equal(await page.locator('#sceneTitle').innerText(), 'Smoke Import');
  assert.equal(await page.locator('#layerCountLabel').textContent(), '06');
  assert.equal(await page.locator('.scene-thumb').count(), 4);
  console.log('PASS · image import, polygon depth mask, IndexedDB save, and reload restore');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click(),
  ]);
  const archivePath = await download.path();
  assert.ok(archivePath, 'project export should create a ZIP download');
  const archiveBytes = await readFile(archivePath);
  await page.locator('#projectInput').setInputFiles({ name: 'roundtrip.zip', mimeType: 'application/zip', buffer: archiveBytes });
  await page.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'Smoke Import', null, { timeout: 12000 });
  assert.equal(await page.locator('#layerCountLabel').textContent(), '06');
  console.log('PASS · ZIP export/import round-trip preserves source image and polygon masks');

  await page.locator('#moreButton').click();
  await page.locator('#resetDemoButton').click();
  assert.equal(await page.locator('#sceneTitle').innerText(), 'The World Between Two Frames');
  assert.equal(await page.locator('.scene-thumb').count(), 4, 'Reset Demo must keep imported images');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#moreButton').click();
  await page.locator('#deleteProjectButton').click();
  await page.waitForFunction(() => document.querySelectorAll('.scene-thumb').length === 3, null, { timeout: 12000 });
  console.log('PASS · Reset Demo preserves uploads; Delete Imported Project removes them separately');

  assert.deepEqual(runtimeErrors, [], `browser console/runtime errors: ${runtimeErrors.join(' | ')}`);
  console.log('PASS · no browser runtime or console errors');
  await context.close(); // release the first WebGL canvas before the touch-viewport pass
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  await mobileContext.addInitScript(() => {
    window.__WBTF_SOURCE_CANVASES = [];
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      const context = nativeGetContext.call(this, type, options);
      if (type === '2d' && options?.alpha === true) window.__WBTF_SOURCE_CANVASES.push(this);
      return context;
    };
  });
  const mobilePage = await mobileContext.newPage();
  const mobileErrors = [];
  mobilePage.on('pageerror', (error) => mobileErrors.push(error.message));
  mobilePage.on('console', (message) => { if (message.type() === 'error') mobileErrors.push(message.text()); });
  mobilePage.setDefaultTimeout(12000);
  await mobilePage.goto(base, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'));
  const mobileLayout = await mobilePage.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    frame: document.querySelector('#frameOutline').getBoundingClientRect().toJSON(),
  }));
  assert.ok(mobileLayout.width <= mobileLayout.viewport, 'mobile layout should not scroll horizontally');
  assert.ok(mobileLayout.frame.width > 300, 'art should remain legible on a phone-sized viewport');
  const mobileHeader = await mobilePage.evaluate(() => ({
    viewport: window.innerWidth,
    actions: [...document.querySelector('.topbar-right').children]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => ({ id: element.id, right: element.getBoundingClientRect().right })),
  }));
  assert.ok(mobileHeader.actions.every((action) => action.right <= mobileHeader.viewport), 'every visible mobile header action should fit onscreen');
  await mobilePage.locator('#moreButton').tap();
  for (const id of ['menuOpenProjectButton', 'menuExportButton', 'menuSoundButton', 'menuFullscreenButton']) {
    assert.equal(await mobilePage.locator(`#${id}`).isVisible(), true, `mobile More menu should expose ${id}`);
  }
  await mobilePage.locator('#menuSoundButton').tap();
  assert.equal(await mobilePage.locator('#menuSoundButton').getAttribute('aria-pressed'), 'true');
  await mobilePage.locator('#menuSoundButton').tap();
  assert.equal(await mobilePage.locator('#menuSoundButton').getAttribute('aria-pressed'), 'false');
  await mobilePage.locator('#moreButton').tap();
  await mobilePage.locator('#depthSlider').evaluate((element) => {
    element.value = '55';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await mobilePage.locator('#enterButton').tap();
  await mobilePage.waitForFunction(() => document.querySelector('#modeLabel')?.textContent === 'EXPLORATION', null, { timeout: 12000 });
  await mobilePage.locator('#approachPortal').tap();
  await mobilePage.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'The Glass Orchard', null, { timeout: 14000 });
  await mobilePage.locator('#imageInput').setInputFiles({ name: 'alpha-transparency.png', mimeType: 'image/png', buffer: makeTransparentPng() });
  await mobilePage.waitForFunction(() => document.querySelector('#sceneTitle')?.textContent === 'Alpha Transparency', null, { timeout: 12000 });
  const alphaPixels = await mobilePage.evaluate(() => {
    const source = window.__WBTF_SOURCE_CANVASES.at(-1);
    if (!source) return null;
    const context = source.getContext('2d');
    return {
      width: source.width,
      height: source.height,
      transparentHole: context.getImageData(160, 90, 1, 1).data[3],
      solidPixel: context.getImageData(20, 20, 1, 1).data[3],
    };
  });
  assert.deepEqual(alphaPixels, { width: 320, height: 180, transparentHole: 0, solidPixel: 255 }, 'source import should retain its original alpha channel');
  assert.deepEqual(mobileErrors, [], `mobile browser errors: ${mobileErrors.join(' | ')}`);
  console.log('PASS · phone navigation, compact controls, and PNG transparency are preserved');
  await mobileContext.close();

  const deniedContext = await browser.newContext({ viewport: { width: 960, height: 600 }, reducedMotion: 'reduce' });
  await deniedContext.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          const request = {
            error: new DOMException('Storage access denied', 'SecurityError'),
            result: null,
            onsuccess: null,
            onerror: null,
            onupgradeneeded: null,
            onblocked: null,
          };
          setTimeout(() => request.onerror?.(new Event('error')), 0);
          return request;
        },
      },
    });
  });
  const deniedPage = await deniedContext.newPage();
  await deniedPage.goto(base, { waitUntil: 'domcontentloaded' });
  await deniedPage.waitForFunction(() => document.querySelector('#loadingScreen')?.classList.contains('done'));
  assert.match(await deniedPage.locator('#statusText').textContent(), /BROWSER STORAGE UNAVAILABLE/);
  console.log('PASS · denied IndexedDB produces an explicit export warning without blocking the experience');
  await deniedContext.close();
} finally {
  await browser?.close();
  await server?.close();
}

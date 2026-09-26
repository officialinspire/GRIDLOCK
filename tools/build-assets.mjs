/**
 * Builds derived art into assets/generated/. Never touches the original PNGs.
 *
 *   node tools/build-assets.mjs            # all outputs
 *   node tools/build-assets.mjs --boxes    # also print prop bounding boxes (for js/assets.js)
 *
 * Outputs
 *   <sheet>.webp           full-resolution WebP of every sheet (much smaller downloads)
 *   props_decor.png/.webp  props sheet with its baked-in checkerboard keyed out to transparency
 *   ui/<name>.png          UI frames cut out of "UI buttons_panels.png" for CSS border-image 9-slicing
 *
 * Uses Playwright's Chromium canvas so it needs no image libraries.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'assets/generated');

async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const g = execSync('npm root -g').toString().trim();
    return createRequire(`${g}/`)('playwright');
  }
}

export const SHEET_FILES = [
  'title_menu decor.png', 'UI icons.png', 'UI buttons_panels.png', 'ownership markers.png',
  'roads_infrastructure.png', 'parks_open spaces.png', 'residential_commercial buildings.png',
  'civic-buildings.png', 'effects.png', 'props_decor.png',
];

/** Frames cut from "UI buttons_panels.png": [x, y, w, h] including the black outline. */
export const UI_CUTS = {
  'btn-cream': [84, 20, 300, 100],
  'btn-gold': [424, 20, 292, 100],
  'btn-plain': [756, 24, 276, 96],
  'btn-disabled': [1072, 20, 300, 100],
  'square-cream': [156, 488, 136, 132],
  'plaque-corners': [52, 616, 344, 144],
  'ribbon-blue': [412, 764, 320, 124],
  'toggle-off': [130, 398, 196, 92],
  'toggle-on': [802, 398, 196, 92],
};

export const slug = (file) => file.replace(/\.png$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

const b64 = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(join(OUT, 'ui'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  const load = async (file) => `data:image/png;base64,${(await readFile(join(ROOT, file))).toString('base64')}`;

  for (const file of SHEET_FILES) {
    const src = await load(file);
    const keyOut = file === 'props_decor.png';
    const { webp, png, boxes } = await page.evaluate(async ({ src, keyOut }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.getElementById('c');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const x = c.getContext('2d');
      x.clearRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0);
      let boxes = null;
      if (keyOut) {
        // Flood-fill the checkerboard from the edges: light, near-neutral pixels only.
        // Every prop has a thick dark outline, so the fill can't leak inside a sprite.
        const W = c.width; const H = c.height;
        const im = x.getImageData(0, 0, W, H); const d = im.data;
        const isBg = (i) => {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // Checker squares are ~RGB 140 and ~200; outlines are < 60, so 115 is a safe cut.
          return Math.min(r, g, b) > 115 && Math.max(r, g, b) - Math.min(r, g, b) < 22;
        };
        const seen = new Uint8Array(W * H);
        const stack = [];
        for (let px = 0; px < W; px++) stack.push(px, (H - 1) * W + px);
        for (let py = 0; py < H; py++) stack.push(py * W, py * W + W - 1);
        while (stack.length) {
          const p = stack.pop();
          if (seen[p]) continue;
          seen[p] = 1;
          if (!isBg(p * 4)) { seen[p] = 2; continue; }
          d[p * 4 + 3] = 0;
          const px = p % W; const py = (p / W) | 0;
          if (px > 0) stack.push(p - 1);
          if (px < W - 1) stack.push(p + 1);
          if (py > 0) stack.push(p - W);
          if (py < H - 1) stack.push(p + W);
        }
        // Soften the grey anti-alias fringe left on the outline's outer edge.
        for (let p = 0; p < W * H; p++) {
          if (seen[p] !== 2) continue;
          const i = p * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const lo = Math.min(r, g, b);
          if (Math.max(r, g, b) - lo < 22 && lo > 60) d[i + 3] = Math.max(0, Math.min(255, Math.round((255 * (115 - lo)) / 55)));
        }
        x.putImageData(im, 0, 0);

        // Bounding boxes of opaque components (downsampled), for the manifest.
        const S = 4, w = Math.ceil(W / S), h = Math.ceil(H / S);
        const m = new Uint8Array(w * h);
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) m[yy * w + xx] = d[((yy * S) * W + xx * S) * 4 + 3] > 200 ? 1 : 0;
        const lab = new Int32Array(w * h); let n = 0; boxes = [];
        for (let i = 0; i < w * h; i++) {
          if (!m[i] || lab[i]) continue;
          n++; const st = [i]; lab[i] = n; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, cnt = 0;
          while (st.length) {
            const k = st.pop(); const kx = k % w, ky = (k / w) | 0; cnt++;
            x0 = Math.min(x0, kx); x1 = Math.max(x1, kx); y0 = Math.min(y0, ky); y1 = Math.max(y1, ky);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = kx + dx, ny = ky + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const j = ny * w + nx;
              if (m[j] && !lab[j]) { lab[j] = n; st.push(j); }
            }
          }
          if (cnt > 150) boxes.push([x0 * S, y0 * S, (x1 - x0 + 1) * S, (y1 - y0 + 1) * S]);
        }
      }
      return { webp: c.toDataURL('image/webp', 0.9), png: keyOut ? c.toDataURL('image/png') : null, boxes };
    }, { src, keyOut });

    await writeFile(join(OUT, `${slug(file)}.webp`), b64(webp));
    if (png) await writeFile(join(OUT, `${slug(file)}.png`), b64(png));
    console.log(`✔ ${file} → generated/${slug(file)}.webp${png ? ' + transparent .png' : ''}`);
    if (boxes && process.argv.includes('--boxes')) console.log(JSON.stringify(boxes));
  }

  // UI frames for border-image.
  const uiSrc = await load('UI buttons_panels.png');
  for (const [name, [sx, sy, sw, sh]] of Object.entries(UI_CUTS)) {
    const png = await page.evaluate(async ({ src, sx, sy, sw, sh }) => {
      const img = new Image(); img.src = src; await img.decode();
      const c = document.getElementById('c'); c.width = sw; c.height = sh;
      const x = c.getContext('2d'); x.clearRect(0, 0, sw, sh);
      x.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      return c.toDataURL('image/png');
    }, { src: uiSrc, sx, sy, sw, sh });
    await writeFile(join(OUT, 'ui', `${name}.png`), b64(png));
  }
  console.log(`✔ ${Object.keys(UI_CUTS).length} UI frames → generated/ui/`);
  await browser.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

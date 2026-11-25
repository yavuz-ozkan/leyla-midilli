// Builds docs/ (the folder GitHub Pages serves), the installable home screen version of the game, from index.html (the artifact source).
// Run: node build-home-screen.mjs   Safe to rerun: it rebuilds docs/ from scratch and the output is byte-identical.
// Needs Node 18 or newer and nothing else. The fonts come from vendor/fonts, so the build never touches the network.
// The voices come from audio-pack.js, which tools/make-audio.mjs makes from audio/lines.json.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(ROOT, 'docs');
const APP_NAME = "Leyla'nın Midillisi";
const SHORT_NAME = 'Midilli';
const CACHE_PREFIX = 'leyla-midilli-';
const ICONS = [
  { file: 'icons/apple-touch-icon-180.png', size: 180, purpose: null },
  { file: 'icons/icon-192.png', size: 192, purpose: 'any' },
  { file: 'icons/icon-512.png', size: 512, purpose: 'any' },
  { file: 'icons/icon-maskable-512.png', size: 512, purpose: 'maskable' },
];

/* ---------- Reading the artifact source ---------- */

function splitArtifact(source) {
  const styleStart = source.indexOf('<style>'), styleEnd = source.indexOf('</style>');
  if (!source.startsWith('<title>') || styleStart < 0 || styleEnd < styleStart) {
    throw new Error('index.html is not in the expected artifact format: it should start with <title>, then metas, then one <style> block, then the markup and scripts. Restore that order and rerun.');
  }
  if (!source.slice(0, styleStart).includes('fonts.googleapis.com')) {
    throw new Error('index.html no longer links the Google Fonts stylesheet before <style>. The build swaps that link for the bundled fonts in vendor/fonts; update build-home-screen.mjs to match the new font setup.');
  }
  const body = source.slice(styleEnd + '</style>'.length).trim();
  if (/<script[^>]+src="https?:/.test(body)) throw new Error('index.html loads a script from another site. The home screen version must work offline: bring that file into vendor/ and teach the build to copy it.');
  if (!body.includes('<script src="audio-pack.js"></script>')) throw new Error('index.html no longer loads audio-pack.js. Without it the game has no voices; restore the script tag or update the build.');
  return { style: source.slice(styleStart, styleEnd + '</style>'.length), body };
}

function readTokens(style) {
  const tokens = {};
  for (const m of style.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens[m[1]] = m[2].toLowerCase();
  for (const name of ['wall', 'floor', 'ink', 'berry', 'coat', 'hair', 'sun']) {
    if (!tokens[name]) throw new Error(`The color token --${name} is missing from index.html :root. The icons and theme color are drawn from it; add it back or update the build.`);
  }
  return tokens;
}

/* ---------- Icons: a tiny supersampled rasterizer and PNG encoder ---------- */

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const polygon = (pts) => (x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// The pony's face with her pink mane and a yellow bow. Each part is drawn twice: a slightly bigger dark copy, then the color, for the outline.
// scale shrinks the picture toward the centre so a maskable icon keeps her inside the safe zone.
function iconLayers(t, scale) {
  const s = (v) => 0.5 + (v - 0.5) * scale, d = (v) => v * scale, O = 0.016;
  const ink = hex(t.ink), coat = hex(t.coat), hair = hex(t.hair), sun = hex(t.sun), layers = [];
  const blob = (x, y, rx, ry, color, outline = true) => { if (outline) layers.push({ shape: ellipse(s(x), s(y), d(rx + O), d(ry + O)), color: ink }); layers.push({ shape: ellipse(s(x), s(y), d(rx), d(ry)), color }); };
  const poly = (pts, color, grow) => { const c = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    layers.push({ shape: polygon(pts.map(([x, y]) => [s(c[0] + (x - c[0]) * grow), s(c[1] + (y - c[1]) * grow)])), color: ink }); layers.push({ shape: polygon(pts.map(([x, y]) => [s(x), s(y)])), color }); };
  [[0.2, 0.74, 0.12], [0.17, 0.56, 0.13], [0.2, 0.38, 0.13], [0.3, 0.23, 0.12]].forEach(([x, y, r]) => blob(x, y, r, r, hair));   // mane
  poly([[0.34, 0.3], [0.38, 0.06], [0.52, 0.26]], coat, 1.16);                                                              // ear
  blob(0.5, 0.52, 0.27, 0.25, coat); blob(0.7, 0.63, 0.18, 0.15, coat);                                                     // head, snout
  layers.push({ shape: ellipse(s(0.56), s(0.6), d(0.2), d(0.14)), color: coat });                                           // hide the seam between them
  blob(0.42, 0.24, 0.13, 0.09, hair);                                                                                       // forelock
  layers.push({ shape: ellipse(s(0.47), s(0.67), d(0.055), d(0.05)), color: mix(coat, hair, 0.55) });                       // cheek
  layers.push({ shape: ellipse(s(0.6), s(0.48), d(0.048), d(0.058)), color: ink }); layers.push({ shape: ellipse(s(0.615), s(0.46), d(0.018), d(0.018)), color: [255, 255, 255] });   // eye
  layers.push({ shape: ellipse(s(0.79), s(0.6), d(0.014), d(0.02)), color: ink });                                          // nostril
  poly([[0.2, 0.26], [0.06, 0.16], [0.06, 0.36]], sun, 1.2); poly([[0.2, 0.26], [0.34, 0.16], [0.34, 0.36]], sun, 1.2); blob(0.2, 0.26, 0.045, 0.045, sun);   // bow
  return layers;
}

function renderIcon(size, tokens, purpose) {
  const layers = iconLayers(tokens, purpose === 'maskable' ? 0.74 : 0.94);
  const top = hex(tokens.wall), low = hex(tokens.floor);
  const SS = 4, pixels = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
          let color = mix(top, low, y);
          for (const layer of layers) if (layer.shape(x, y)) color = layer.color;
          acc[0] += color[0]; acc[1] += color[1]; acc[2] += color[2];
        }
      }
      const o = (py * size + px) * 3;
      for (let i = 0; i < 3; i++) pixels[o + i] = Math.round(acc[i] / (SS * SS));
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- The page, manifest and service worker ---------- */

function homeScreenPage({ style, body }, tokens, fontCss) {
  return `<!doctype html>
<html lang="tr" class="home-screen">
<head>
<meta charset="utf-8">
<title>${APP_NAME}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="${SHORT_NAME}">
<meta name="application-name" content="${APP_NAME}">
<meta name="theme-color" content="${tokens.wall}">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<style>
/* Fonts bundled for offline play (SIL Open Font License, see fonts/OFL-*.txt). The latin-ext files carry the Turkish letters. */
${fontCss.trim()}
</style>
${style}
<style>
/* Home screen build only: outside the artifact host nothing pads for the status bar and home indicator, so do it here. */
html.home-screen { background: var(--wall); }
html.home-screen body { margin: 0; padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
</style>
</head>
<body>
${body}
<script>
// Offline play: the service worker keeps every file of the game on the tablet after the first visit.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline play is not set up yet; the game still works online.', err));
  });
}
</script>
</body>
</html>
`;
}

function manifest(tokens) {
  return JSON.stringify({
    name: APP_NAME,
    short_name: SHORT_NAME,
    description: 'A pony game in Turkish, by Baba and Leyla',
    lang: 'tr',
    start_url: './',
    scope: './',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'any',
    background_color: tokens.wall,
    theme_color: tokens.wall,
    icons: ICONS.filter((i) => i.purpose).map((i) => ({ src: i.file, sizes: `${i.size}x${i.size}`, type: 'image/png', purpose: i.purpose })),
  }, null, 2) + '\n';
}

function serviceWorker(files, version) {
  return `// Generated by build-home-screen.mjs. Cache-first, so the game starts with the network off after one visit.
const CACHE = '${CACHE_PREFIX}${version}';
const FILES = ${JSON.stringify(['./', ...files], null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('${CACHE_PREFIX}') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)));
});
`;
}

/* ---------- Build ---------- */

function listFiles(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = path.join(dir, name), rel = prefix + name;
    return statSync(full).isDirectory() ? listFiles(full, rel + '/') : [rel];
  });
}

function write(rel, data) {
  const full = path.join(SITE, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, data);
}

function build() {
  const source = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const parts = splitArtifact(source), tokens = readTokens(parts.style);
  const pack = path.join(ROOT, 'audio-pack.js');
  if (!existsSync(pack)) throw new Error('audio-pack.js is missing. Make it with: node tools/make-audio.mjs');
  const fontDir = path.join(ROOT, 'vendor/fonts'), fontCss = readFileSync(path.join(fontDir, 'fonts.css'), 'utf8');
  rmSync(SITE, { recursive: true, force: true });
  write('index.html', homeScreenPage(parts, tokens, fontCss));
  write('manifest.webmanifest', manifest(tokens));
  write('audio-pack.js', readFileSync(pack));
  for (const name of readdirSync(fontDir).sort()) if (name !== 'fonts.css') write('fonts/' + name, readFileSync(path.join(fontDir, name)));
  for (const icon of ICONS) write(icon.file, renderIcon(icon.size, tokens, icon.purpose));
  const files = listFiles(SITE);
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(path.join(SITE, f)));
  const version = hash.digest('hex').slice(0, 12);
  write('sw.js', serviceWorker([...files, 'sw.js'].sort(), version));
  console.log(`Built ${path.relative(ROOT, SITE)}/ (${files.length + 1} files, cache ${CACHE_PREFIX}${version}).`);
}

build();

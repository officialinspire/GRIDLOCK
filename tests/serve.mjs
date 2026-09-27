/** Zero-dependency static server for local play and smoke tests. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/**
 * @param port
 * @param opts.base  serve the site under a subpath (e.g. '/GRIDLOCK/', like a GitHub Pages project site)
 *
 * `server.overrides` maps a site-relative path (e.g. 'sw.js') to a function that
 * rewrites that file's body per request, so tests can publish a "new version".
 */
export function startServer(port = 0, { base = '/' } = {}) {
  const overrides = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!pathname.startsWith(base)) throw Object.assign(new Error('outside base'), { code: 'ENOENT' });
      const urlPath = `/${pathname.slice(base.length)}`;
      let file = normalize(join(ROOT, urlPath));
      if (!file.startsWith(ROOT)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      let body = await readFile(file);
      const override = overrides.get(file.slice(ROOT.length + 1).split('\\').join('/'));
      if (override) body = Buffer.from(override(body.toString()));
      // Always revalidate, so tests see the files currently on disk (and any override).
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (err) {
      res.writeHead(err.code === 'EACCES' ? 403 : 404);
      res.end('Not found');
    }
  });
  server.overrides = overrides;
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  const server = await startServer(port);
  console.log(`Grid Lock City → http://127.0.0.1:${server.address().port}/`);
}

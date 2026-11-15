/**
 * Minimal static file server for the production build smoke test.
 * Serves dist/public/ on PORT (default 4321).
 * Handles SPA fallback (all unknown routes → index.html).
 */
import { createServer } from 'node:http';
import { readFile, stat }      from 'node:fs/promises';
import { join, extname }       from 'node:path';
import { fileURLToPath }       from 'node:url';
import { dirname }             from 'node:path';

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, 'dist', 'public');
const PORT    = process.env.SERVE_PORT ?? 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  // strip query string
  const urlPath = req.url.split('?')[0];
  let filePath = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // SPA fallback: if file not found and no extension, serve index.html
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
  } catch {
    filePath = join(ROOT, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    const ext  = extname(filePath);
    res.writeHead(200, {
      'Content-Type':             MIME[ext] ?? 'application/octet-stream',
      'Cache-Control':            'no-store',
      'Service-Worker-Allowed':   '/',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`[prod-server] http://localhost:${PORT}/`);
});

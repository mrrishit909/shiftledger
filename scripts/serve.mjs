// Local static preview of dist/ on 127.0.0.1 only. GET/HEAD files; no APIs, no uploads.
import { createServer as httpServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
};

export function createServer(rootDir) {
  const root = realpathSync(resolve(rootDir)); // canonical root so the realpath check below compares like with like
  return httpServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    let path;
    try { path = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]); } catch { return send(400, 'Bad Request'); }
    if (path.includes('\0') || path.includes('\\') || !path.startsWith('/')) return send(400, 'Bad Request');
    if (path.split('/').some((seg) => seg === '..' || seg === '.')) return send(403, 'Forbidden');
    let file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden');
    try {
      let info = await stat(file);
      if (info.isDirectory()) {
        if (!path.endsWith('/')) return send(301, 'Moved', { Location: `${path}/` });
        file = join(file, 'index.html');
        info = await stat(file);
      }
      const real = await realpath(file);
      if (!real.startsWith(root + sep) || !info.isFile()) return send(403, 'Forbidden');
      const body = await readFile(real);
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': MIME[extname(real)] ?? 'application/octet-stream', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      send(404, 'Not Found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const port = Number(process.env.PORT ?? 4173);
  createServer(root).listen(port, '127.0.0.1', () => console.log(`ShiftLedger preview: http://127.0.0.1:${port}/ (serving ${root})`));
}

import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const publicRoot = path.join(projectRoot, 'public');
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
// Observe violations before enforcement: remote WASM/module loading still
// needs a real Safari/Chrome run. Report-Only does not prevent script execution.
export const candidateCSP = "default-src 'none'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; worker-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' blob:; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'";

export async function createServer({ basePath = '/' } = {}) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error('Invalid preview base path.');
  const root = await realpath(publicRoot);
  if (!inside(projectRoot, root)) throw new Error('Public path is outside the project.');
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    response.setHeader('Content-Security-Policy-Report-Only', candidateCSP);
    // The preview is loopback-only. Reject unexpected Host values as another
    // barrier against DNS rebinding; this is not a production server.
    if (request.headers.host !== `127.0.0.1:${request.socket.localPort}` && request.headers.host !== `localhost:${request.socket.localPort}`) {
      response.writeHead(403); response.end(); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return; }
    try {
      const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!requested.startsWith(basePath)) { response.writeHead(404); response.end(); return; }
      const pathname = '/' + requested.slice(basePath.length);
      let target = path.resolve(root, `.${pathname}`);
      if (!inside(root, target)) { response.writeHead(403); response.end(); return; }
      if (pathname.split('/').some(part => part.startsWith('.')) || pathname.includes('\\')) { response.writeHead(404); response.end(); return; }
      if (!pathname.endsWith('/') && !Object.hasOwn(types, path.extname(pathname))) { response.writeHead(404); response.end(); return; }
      // Reject symlinks before stat/read; only public assets can be served.
      target = await realpath(target);
      if (!inside(root, target)) { response.writeHead(403); response.end(); return; }
      if ((await stat(target)).isDirectory()) {
        target = await realpath(path.join(target, 'index.html'));
        if (!inside(root, target)) { response.writeHead(403); response.end(); return; }
      }
      if (!Object.hasOwn(types, path.extname(target))) { response.writeHead(404); response.end(); return; }
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      response.writeHead(error instanceof URIError ? 400 : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500);
      response.end();
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const server = await createServer();
  server.listen(4187, '127.0.0.1', () => process.stdout.write('CommuteLingo: http://127.0.0.1:4187/\n'));
}

// The panel's HTTP app (127.0.0.1:PANEL_PORT): <base>/auth, <base>/api, <base>/game, <base>/files and the React UI
// (web/dist) with SPA fallback.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { config } from './config.js';
import { authRoutes } from './auth.js';
import { apiRoutes } from './api.js';
import { gameRoutes } from './game.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
// Vite's hashed output: name-<8+ chars hash>.ext (or anything under assets/).
const HASHED = /(^|\/)assets\/|[-.][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;

// web/dist is looked up per request, so `pnpm build:web` needs no panel restart. Existing file -> served (hashed assets
// immutable, others no-cache); missing file under assets/ or with a file extension -> 404; anything else -> index.html
// (SPA route, no-cache). No UI built -> a small placeholder page.
async function serveUi(req, reply, rel, webDist, base) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return reply.code(400).send({ error: 'bad path' }); }
  const root = path.resolve(webDist);
  if (decoded && !decoded.endsWith('/')) {
    const abs = path.resolve(root, decoded);
    if (abs.startsWith(root + path.sep)) {
      const st = await fs.promises.stat(abs).catch(() => null);
      if (st?.isFile()) {
        reply.header('Content-Type', MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream').header('Content-Length', st.size)
          .header('Cache-Control', HASHED.test(decoded) && path.basename(abs) !== 'index.html' ? 'public, max-age=31536000, immutable' : 'no-cache')
          .header('X-Content-Type-Options', 'nosniff');
        return reply.send(req.method === 'HEAD' ? '' : fs.createReadStream(abs));
      }
    }
    if (decoded.startsWith('assets/') || /\.[A-Za-z0-9]{1,8}$/.test(path.basename(decoded))) return reply.code(404).type('text/plain; charset=utf-8').header('Cache-Control', 'no-store').send('not found');
  }
  const html = await fs.promises.readFile(path.join(root, 'index.html'), 'utf8').catch(() => null);
  reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache');
  if (html !== null) return reply.send(html);
  return reply.send(`<!doctype html><meta charset="utf-8"><title>Kora QA</title><body style="font-family:system-ui;background:#0f1115;color:#ddd;padding:40px"><h1>Kora QA panel</h1><p>The UI is not built yet (web/dist missing). The API is at <code>${base}/api</code>; <a style="color:#7aa2ff" href="${base}/auth/login">log in</a>.</p></body>`);
}

export async function buildApp({ logger = false, fetchFn, applyFix, webDist = WEB_DIST } = {}) {
  const app = Fastify({ logger, bodyLimit: 4 * 1024 * 1024, trustProxy: false });
  const base = config().basePath;
  await app.register(cookie, { secret: config().sessionSecret || undefined });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    if (req.url.startsWith(`${base}/api/`)) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  authRoutes(app, fetchFn ? { fetchFn } : {});
  apiRoutes(app, applyFix ? { applyFix } : {});
  gameRoutes(app);

  app.get(base, async (_req, reply) => reply.redirect(`${base}/`, 301));
  const reserved = ['/api/', '/game/', '/auth/', '/files/'].map((p) => `${base}${p}`);
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0];
    if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith(`${base}/`) && !reserved.some((p) => url.startsWith(p))) {
      return serveUi(req, reply, url.slice(base.length + 1), webDist, base);
    }
    return reply.code(404).send({ error: 'not found' });
  });
  return app;
}

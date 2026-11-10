// Runs the worker under Node with SQLite in place of D1 (workerd does not start on this machine). node dev.mjs [port]
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';

const vars = Object.fromEntries(readFileSync(new URL('./.dev.vars', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const site = fileURLToPath(new URL('../site/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/markdown' };
const ASSETS = {
  fetch: async (req) => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(site, p));
    if (!file.startsWith(normalize(site)) || !existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'content-type': types[extname(file)] || 'application/octet-stream' } });
  },
};
const env = { ...vars, DB: sqliteD1(process.env.DB_FILE || ':memory:'), ASSETS, GUARD_PER_DAY: '500' };
const port = Number(process.argv[2] || 8799);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`griffin dev on http://localhost:${port}`));

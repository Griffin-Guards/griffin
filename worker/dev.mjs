// Runs the worker under Node with SQLite in place of D1. node dev.mjs [port]
// Settings come from .dev.vars (GRIFFIN_KEY, RH_RPC_URL, MODULE, MODULE_FROM_BLOCK); the environment wins over the file.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';

const file = new URL('./.dev.vars', import.meta.url);
const vars = existsSync(file) ? Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])) : {};
for (const k of ['GRIFFIN_KEY', 'RH_RPC_URL', 'MODULE', 'MODULE_FROM_BLOCK']) if (process.env[k]) vars[k] = process.env[k];
const env = { ...vars, DB: sqliteD1(process.env.DB_FILE || ':memory:'), GUARD_PER_DAY: '500' };
const port = Number(process.argv[2] || 8834);
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`griffin-rh dev on http://localhost:${port}`));

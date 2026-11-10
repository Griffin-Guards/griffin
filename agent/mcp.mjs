// Local MCP server over stdio. Every move needs Griffin's vote, so the agent can only act inside the owner's policy.
import readline from 'node:readline';
import { loadConfig, status, sendSol, sendToken, swap } from './griffin-agent.mjs';

const TOOLS = [
  { name: 'griffin_status', description: 'Wallet balance, the owner policy, SOL spent in the last 24h and recent verdicts. Read this before planning a move.', inputSchema: { type: 'object', properties: {} } },
  { name: 'griffin_send_sol', description: 'Send SOL from the guarded wallet. Griffin passes it only to listed recipients and inside the limits.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, amount: { type: 'string', description: 'SOL, e.g. 0.05' } }, required: ['to', 'amount'] } },
  { name: 'griffin_send_token', description: 'Send an SPL token from the guarded wallet to a listed recipient.', inputSchema: { type: 'object', properties: { mint: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string', description: 'Whole tokens, e.g. 12.5' } }, required: ['mint', 'to', 'amount'] } },
  { name: 'griffin_swap', description: 'Swap through Jupiter from the guarded wallet. amount is in base units of the input token (lamports for SOL).', inputSchema: { type: 'object', properties: { inputMint: { type: 'string' }, outputMint: { type: 'string' }, amount: { type: 'string' }, slippageBps: { type: 'number' } }, required: ['inputMint', 'outputMint', 'amount'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) }] });

async function runTool(name, a) {
  const cfg = loadConfig();
  if (name === 'griffin_status') return status(cfg);
  if (name === 'griffin_send_sol') return sendSol(cfg, a.to, a.amount);
  if (name === 'griffin_send_token') return sendToken(cfg, a.mint, a.to, a.amount);
  if (name === 'griffin_swap') return swap(cfg, a.inputMint, a.outputMint, a.amount, a.slippageBps || 100);
  throw new Error('unknown tool');
}

export function serve() {
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') {
      return ok({
        protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'griffin', version: '0.1.0' },
        instructions: 'Your wallet needs two votes. You hold one; Griffin votes only for moves inside the owner\'s policy. A TURNED BACK verdict is final: do not try to split or reroute the move to get around it.',
      });
    }
    if (m.method === 'ping') return ok({});
    if (m.method === 'tools/list') return ok({ tools: TOOLS });
    if (m.method === 'tools/call') {
      try { return ok(text(await runTool(m.params.name, m.params.arguments || {}))); } catch (e) {
        return ok({ ...text({ error: e.message }), isError: true });
      }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown method' } });
  });
}

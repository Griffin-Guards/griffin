// Local MCP server over stdio. Every move goes through GriffinModule, so the agent can only act inside the Safe's charter.
import readline from 'node:readline';
import { loadConfig, status, sendEth, sendToken, call } from './griffin-agent.mjs';

const TOOLS = [
  { name: 'griffin_status', description: 'The Safe\'s ETH balance, its on-chain charter (ETH per move and per day, spent today, recipients, token limits, contracts) and recent verdicts. Read this before planning a move.', inputSchema: { type: 'object', properties: {} } },
  { name: 'griffin_send_eth', description: 'Send ETH from the Safe. Passes only to listed recipients and inside the limits.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, amount: { type: 'string', description: 'ETH, e.g. 0.01' } }, required: ['to', 'amount'] } },
  { name: 'griffin_send_token', description: 'Send an ERC-20 token the charter lists to a listed recipient.', inputSchema: { type: 'object', properties: { token: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string', description: 'Whole tokens, e.g. 12.5' } }, required: ['token', 'to', 'amount'] } },
  { name: 'griffin_call', description: 'Call a contract the charter lists (a DEX router, for example) from the Safe. data is hex calldata, value in ETH. Approve a listed token to that contract first if it pulls tokens.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, data: { type: 'string' }, value: { type: 'string' } }, required: ['to', 'data'] } },
];

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) }] });

async function runTool(name, a) {
  const cfg = loadConfig();
  if (name === 'griffin_status') return status(cfg);
  if (name === 'griffin_send_eth') return sendEth(cfg, a.to, a.amount);
  if (name === 'griffin_send_token') return sendToken(cfg, a.token, a.to, a.amount);
  if (name === 'griffin_call') return call(cfg, a.to, a.data, a.value || '0');
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
        protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'griffin-rh', version: '0.1.0' },
        instructions: 'You spend from a Safe on Robinhood Chain through GriffinModule. The owner\'s charter is enforced on chain and Griffin co-signs each move. A TURNED BACK verdict is final: do not try to split or reroute the move to get around it.',
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

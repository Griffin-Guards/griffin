#!/usr/bin/env node
// griffin-rh status | send <to> <eth> | send-token <token> <to> <amount> | call <to> <data> [eth] | mcp
import { loadConfig, status, sendEth, sendToken, call } from './griffin-agent.mjs';
import { serve } from './mcp.mjs';

const [cmd, ...args] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const usage = 'griffin-rh status | send <to> <eth> | send-token <token> <to> <amount> | call <to> <data> [eth] | mcp';

try {
  if (cmd === 'mcp') serve();
  else {
    const cfg = loadConfig();
    if (cmd === 'status') out(await status(cfg));
    else if (cmd === 'send') out(await sendEth(cfg, args[0], args[1]));
    else if (cmd === 'send-token') out(await sendToken(cfg, args[0], args[1], args[2]));
    else if (cmd === 'call') out(await call(cfg, args[0], args[1], args[2] || '0'));
    else console.log(usage);
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

#!/usr/bin/env node
// griffin status | send <to> <sol> | send-token <mint> <to> <amount> | swap <inMint> <outMint> <baseUnits> [slippageBps] | mcp
import { loadConfig, status, sendSol, sendToken, swap } from './griffin-agent.mjs';
import { serve } from './mcp.mjs';

const [cmd, ...args] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2));

try {
  if (cmd === 'mcp') serve();
  else {
    const cfg = loadConfig();
    if (cmd === 'status') out(await status(cfg));
    else if (cmd === 'send') out(await sendSol(cfg, args[0], args[1]));
    else if (cmd === 'send-token') out(await sendToken(cfg, args[0], args[1], args[2]));
    else if (cmd === 'swap') out(await swap(cfg, args[0], args[1], args[2], Number(args[3] || 100)));
    else console.log('griffin status | send <to> <sol> | send-token <mint> <to> <amount> | swap <inMint> <outMint> <baseUnits> [slippageBps] | mcp');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

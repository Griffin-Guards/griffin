// Writes the static pages of the site from one shared head, header and footer. node pages.mjs -> ../site/<page>/index.html
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE = 'https://griffinguard.fun';
const NAV = [
  ['/how/', 'How it works'], ['/charter/', 'The charter'], ['/gate/', 'The gate'], ['/agents/', 'Agents'], ['/limits/', 'Limits & FAQ'], ['/token/', '$GRIFFIN'],
];

const head = ({ path, title, description }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${SITE}${path}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@griffindotfun">
<meta name="twitter:image" content="${SITE}/og-image.png">
<link rel="icon" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Manrope:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/site.css">
</head>
<body>`;

const nav = (path) => `<nav>
      <a class="brand" href="/"><img src="/logo.png" alt="">GRIFFIN</a>
      <span class="links">${NAV.map(([h, t]) => `<a href="${h}"${h === path ? ' aria-current="page"' : ''}>${t}</a>`).join('')}<a href="#" data-x target="_blank" rel="noopener">X</a></span>
      <a class="cta" href="/app/">Open app</a>
      <details class="menu"><summary>Menu</summary><div class="drop">${NAV.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}<a href="#" data-x target="_blank" rel="noopener">X</a><a href="#" data-github target="_blank" rel="noopener">GitHub</a></div></details>
    </nav>`;

// inner pages open on a short wall with the page's number and title
const banner = (path, num, title, lead) => `<header class="keep short">
  <div class="wrap">
    ${nav(path)}
    <div class="banner"><div class="num">${num}</div><div><h1>${title}</h1><p>${lead}</p></div></div>
  </div>
</header>`;

const next = (prev, nxt) => `<div class="next">${prev ? `<a href="${prev[0]}">← ${prev[1]}</a>` : '<span></span>'}${nxt ? `<a href="${nxt[0]}">${nxt[1]} →</a>` : ''}</div>`;
const around = (path) => { const i = NAV.findIndex(([h]) => h === path); return next(NAV[i - 1] || ['/', 'Home'], NAV[i + 1]); };

const footer = `<div class="wrap"><footer><span>GRIFFIN · a second key for agent wallets on Solana · not financial advice</span><span><a href="/app/">App</a> · <a href="/agents/">Agents</a> · <a href="#" data-github target="_blank" rel="noopener">GitHub</a> · <a href="#" data-x target="_blank" rel="noopener">X</a></span></footer></div>
<script src="/assets/site.js"></script>
</body>
</html>
`;

const lanes = (max) => `<div class="tally"><span><b data-n="passed">0</b>passed</span><span><b data-n="turnedBack">0</b>turned back</span><span><b data-n="wallets">0</b>guarded wallets</span></div>
    <div class="lanes">
      <div class="lane p"><h3><span>PASSED</span><span>went through</span></h3><div data-lane="passed" data-max="${max}"><div class="empty">Waiting for the first move…</div></div></div>
      <div class="portcullis" aria-hidden="true"></div>
      <div class="lane b"><h3><span>TURNED BACK</span><span>stopped</span></h3><div data-lane="turned back" data-max="${max}"><div class="empty">Nothing stopped yet.</div></div></div>
    </div>`;

const keys = `<div class="keys">
      <div class="key"><div class="tag">Key 1 · you</div><h3>Owner</h3><ul><li>Signs the charter</li><li>Swaps the agent key in one transaction</li><li>Can dismiss Griffin alone, any time</li><li>Your own moves always pass</li></ul></div>
      <div class="key"><div class="tag">Key 2 · your bot</div><h3>Agent</h3><ul><li>Lives on the agent's machine</li><li>Proposes moves and votes for them</li><li>One vote is never enough</li><li>A leaked agent key can't drain the wallet</li></ul></div>
      <div class="key g"><div class="tag">Key 3 · the guard</div><h3>Griffin</h3><ul><li>Can only vote, can't propose</li><li>Simulates each move first</li><li>Votes yes inside the charter</li><li>Says no, with reasons, outside it</li></ul></div>
    </div>`;

const pages = {
  '/': {
    title: "GRIFFIN · the second key on your agent's wallet",
    description: 'Your AI agent holds one key. Griffin holds the other, and only signs moves inside the limits you set. Squads multisig on Solana, MCP and REST.',
    body: `<header class="keep">
  <div class="wrap">
    ${nav('/')}
    <div class="hero">
      <div>
        <h1>Your agent holds one key.<br><em>Griffin holds the other.</em></h1>
        <p class="lead">An AI agent with a hot wallet is one bad prompt away from empty. Put its funds in a Squads wallet that needs two votes. The agent casts one. Griffin casts the second only when the move fits the charter you signed.</p>
        <div class="btns"><a class="btn gold" href="/app/">Guard an agent wallet</a><a class="btn" href="/how/">How it works</a></div>
        <div class="ca mono" data-ca hidden></div>
      </div>
      <div class="crest"><div class="shield"><img src="/logo.png" alt="Griffin"></div><div class="motto">Nothing leaves unseen</div></div>
    </div>
  </div>
</header>

<section>
  <div class="wrap">
    <div class="kicker">Three keys, two votes</div>
    <h2>The agent can ask. It can't take.</h2>
    <p class="sub">Every Griffin wallet is a plain Squads v4 multisig on Solana. Nothing custom holds your funds, and you can read every member and rule on chain.</p>
    ${keys}
    <div class="flow"><span>agent proposes</span>→<span>Griffin simulates</span>→<span>checks the charter</span>→<span><b>PASSED</b> second vote + execute</span>or<span><b>TURNED BACK</b> reasons</span></div>
  </div>
</section>

<section class="gate">
  <div class="wrap">
    <div class="kicker">Live</div>
    <h2>At the gate right now</h2>
    <p class="sub">The latest moves Griffin judged. <a href="/gate/">The whole gate →</a></p>
    ${lanes(3)}
  </div>
</section>

<section>
  <div class="wrap">
    <div class="kicker">Read on</div>
    <h2>The rest of the keep</h2>
    <div class="folio">
      <a href="/how/"><div class="tag">I</div><b>How it works</b><span>One move from proposal to release, and what each key can do.</span></a>
      <a href="/charter/"><div class="tag">II</div><b>The charter</b><span>The limits you sign, and the moves Griffin never lets through.</span></a>
      <a href="/gate/"><div class="tag">III</div><b>The gate</b><span>Every verdict, live, with the reasons.</span></a>
      <a href="/agents/"><div class="tag">IV</div><b>Agents</b><span>MCP server, CLI and API for the bot side.</span></a>
      <a href="/limits/"><div class="tag">V</div><b>Limits & FAQ</b><span>What Griffin can't do, said plainly.</span></a>
      <a href="/token/"><div class="tag">VI</div><b>$GRIFFIN</b><span>The project's token and what its fees pay for.</span></a>
    </div>
  </div>
</section>`,
  },

  '/how/': {
    title: 'How it works · GRIFFIN',
    description: 'How a Griffin-guarded agent wallet works: a Squads v4 multisig with three keys, two votes, and a co-signer that simulates every move.',
    body: `${banner('/how/', 'I', 'How it works', 'One move, from the agent asking to the money landing, and who can do what along the way.')}
<section>
  <div class="wrap">
    <div class="kicker">The keys</div>
    <h2>Three keys, two votes</h2>
    <p class="sub">The wallet is a Squads v4 multisig: threshold 2, no time lock. You are the config authority, so the membership is yours to change without asking anyone.</p>
    ${keys}
  </div>
</section>
<section style="padding-top:0">
  <div class="wrap">
    <div class="kicker">One move</div>
    <h2>From proposal to release</h2>
    <ol class="walk">
      <li><div><b>The agent proposes.</b><span>It creates a vault transaction and a proposal, and votes for it. That is 1 of 2. Nothing can move yet.</span></div></li>
      <li><div><b>It asks Griffin.</b><span>One call: <span class="mono">POST /v1/guard</span> with the wallet and the move's number, or the <span class="mono">griffin_send_sol</span> / <span class="mono">griffin_swap</span> tools that do all of it.</span></div></li>
      <li><div><b>Griffin reads it from chain and runs it.</b><span>It simulates its own vote plus the execution and reads every account the move writes, before and after. What counts is what the simulation shows leaving the wallet, not what the agent says.</span></div></li>
      <li><div><b>The charter decides.</b><span>Recipients, programs, SOL and token limits, the 24 hour total, and the moves that are never allowed.</span></div></li>
      <li><div><b>PASSED or TURNED BACK.</b><span>Passed: Griffin returns a transaction with its vote, the execution and the cleanup, already signed by Griffin. The agent signs as fee payer and sends it. Turned back: the reasons, and the proposal stays at 1 of 2.</span></div></li>
    </ol>
  </div>
</section>
<section class="gate">
  <div class="wrap">
    <div class="kicker">Your side</div>
    <h2>The owner keeps the crown</h2>
    <div class="cols">
      <div><p class="sub">Your own moves pass without a check. From the app, Griffin adds its vote itself after you sign, because wallets like Phantom add their own instructions to a transaction and that would void a signature made in advance.</p></div>
      <div><p class="sub">If the agent's machine is lost, swap the agent key in one transaction. If Griffin is down or you stop trusting it, dismiss it in one transaction and the wallet becomes yours alone. No vote, no wait.</p></div>
    </div>
  </div>
</section>
<section><div class="wrap">${around('/how/')}</div></section>`,
  },

  '/charter/': {
    title: 'The charter · GRIFFIN',
    description: 'The policy you sign for your agent: SOL and token limits, recipients, programs, and the moves Griffin always turns back.',
    body: `${banner('/charter/', 'II', 'The charter', 'You set the numbers and seal them with the owner key. Griffin holds every agent move to these articles.')}
<section>
  <div class="wrap">
    <div class="charter">
      <ol>
        <li><b>SOL per move</b><span>The most one move may take out, counted from the simulation, wrapped SOL included.</span></li>
        <li><b>SOL per day</b><span>A rolling 24 hours of everything Griffin let through.</span></li>
        <li><b>Recipients</b><span>Plain SOL or token transfers only reach wallets on your list. SOL wrapped into the wallet's own account stays the wallet's.</span></li>
        <li><b>Programs</b><span>System, Token, Token-2022, ATA, Compute Budget, Memo and Jupiter v6 by default. Anything else you add by address.</span></li>
        <li><b>No spenders</b><span>Approvals, authority changes and closing accounts into another wallet are always turned back.</span></li>
        <li><b>Something back</b><span>A move that pays out and returns nothing to the wallet is turned back.</span></li>
        <li><b>Token limits</b><span>Per move and per day caps for any token you name, and a buy list if you want one.</span></li>
        <li><b>Your moves</b><span>Moves the owner key proposes pass without a check. It's your wallet.</span></li>
      </ol>
      <div class="seal"><img src="/logo.png" alt=""></div>
    </div>
  </div>
</section>
<section style="padding-top:20px">
  <div class="wrap cols">
    <div>
      <div class="kicker">The seal</div>
      <h2>Only the owner signs it</h2>
      <p class="sub">The charter is a message your wallet signs. It is free and moves nothing. Griffin checks the signature against the wallet's config authority, so an agent can't loosen its own leash, and an old charter can't be replayed over a newer one.</p>
    </div>
<pre>GRIFFIN policy
wallet: &lt;your Squads wallet&gt;
hash: &lt;sha256 of the charter&gt;
nonce: &lt;time you signed&gt;</pre>
  </div>
</section>
<section style="padding-top:0">
  <div class="wrap">
    <div class="kicker">Whatever the charter says</div>
    <h2>Always turned back</h2>
    <ul class="wall">
      <li>Letting anyone else spend the wallet's tokens (approve).</li>
      <li>Changing who owns or can close a token account.</li>
      <li>System calls other than a plain transfer.</li>
      <li>A program that is not on the list, anywhere at the top of the move.</li>
      <li>A simulated result where a delegate, an owner or a close authority changes.</li>
      <li>A move that fails in simulation, and any wallet with no charter yet.</li>
    </ul>
    ${around('/charter/')}
  </div>
</section>`,
  },

  '/gate/': {
    title: 'The gate · GRIFFIN',
    description: 'Every move Griffin judged, live: what passed, what was turned back, and why.',
    body: `${banner('/gate/', 'III', 'The gate', 'Every move Griffin judged, as it happens, with the reasons. Wallets are shortened. Nothing here is a payment from us.')}
<section class="gate">
  <div class="wrap">
    <div class="tally"><span><b data-n="passed">0</b>passed</span><span><b data-n="turnedBack">0</b>turned back</span><span><b data-n="wallets">0</b>guarded wallets</span></div>
    <div class="filters"><button data-filter="all" aria-pressed="true">ALL</button><button data-filter="passed" aria-pressed="false">PASSED</button><button data-filter="turned back" aria-pressed="false">TURNED BACK</button></div>
    <div class="feed" data-feed><div class="empty">Waiting for the first move…</div></div>
  </div>
</section>
<section><div class="wrap">${around('/gate/')}</div></section>`,
  },

  '/agents/': {
    title: 'Agents · GRIFFIN',
    description: 'Run your agent on a Griffin-guarded wallet: a local MCP server and CLI, a hosted read-only MCP, and a small REST API.',
    body: `${banner('/agents/', 'IV', 'Agents', 'Give your bot the wallet, not the vault. The agent key stays on its machine.')}
<section>
  <div class="wrap cols">
    <div>
      <div class="kicker">Set up</div>
      <h2>Four steps</h2>
      <ol class="steps">
        <li>Open the <a href="/app/">app</a>, connect your wallet, paste the agent's public key (or make one there), create.</li>
        <li>Sign a charter. Until you do, every agent move is turned back.</li>
        <li>Fund the vault, and give the agent key a little SOL for fees and proposal rent.</li>
        <li>Run the Griffin MCP server next to your agent. It proposes, asks Griffin and sends the release.</li>
      </ol>
      <p class="sub" style="margin-top:18px">Local tools: <span class="mono">griffin_status</span>, <span class="mono">griffin_send_sol</span>, <span class="mono">griffin_send_token</span>, <span class="mono">griffin_swap</span>. Swaps ask Jupiter again without any DEX Griffin would not pass, so the route fits the charter.</p>
    </div>
<pre>{
  "mcpServers": {
    "griffin": {
      "command": "node",
      "args": ["griffin/agent/cli.mjs", "mcp"],
      "env": {
        "GRIFFIN_AGENT_KEY": "~/.griffin/agent.json",
        "GRIFFIN_WALLET": "&lt;wallet from the app&gt;",
        "SOL_RPC_URL": "&lt;your RPC&gt;"
      }
    }
  }
}

# or the CLI
node agent/cli.mjs status
node agent/cli.mjs send &lt;to&gt; 0.05
node agent/cli.mjs swap &lt;inMint&gt; &lt;outMint&gt; &lt;baseUnits&gt;</pre>
  </div>
</section>
<section class="gate">
  <div class="wrap">
    <div class="kicker">Hosted</div>
    <h2>API and read-only MCP</h2>
    <p class="sub">Base: <span class="mono" data-origin>https://griffinguard.fun</span>. The hosted MCP at <span class="mono">/mcp</span> has <span class="mono">griffin_check</span> and <span class="mono">griffin_policy</span>, for agents that build their own Squads proposals.</p>
    <div class="scroll"><table class="table" style="color:var(--cream)">
      <tr><th>Call</th><th>What it does</th></tr>
      <tr><td><code>GET /v1/griffin</code></td><td>Griffin's vote key and the base program list</td></tr>
      <tr><td><code>GET /v1/wallet/:multisig</code></td><td>Members, whether Griffin can guard it, the charter, recent verdicts</td></tr>
      <tr><td><code>POST /v1/policy</code></td><td><code>{ multisig, policy, nonce, signature }</code>, signed by the owner</td></tr>
      <tr><td><code>POST /v1/guard</code></td><td><code>{ multisig, index }</code> → verdict, and the release transaction when passed</td></tr>
      <tr><td><code>GET /v1/feed</code>, <code>/v1/stats</code></td><td>The gate: latest verdicts and counts</td></tr>
    </table></div>
  </div>
</section>
<section><div class="wrap">${around('/agents/')}</div></section>`,
  },

  '/limits/': {
    title: 'Limits & FAQ · GRIFFIN',
    description: "What Griffin can't do, what it costs, and answers to the common questions.",
    body: `${banner('/limits/', 'V', 'Limits & FAQ', 'Read this before you put real money behind an agent.')}
<section class="limits" style="border-top:0">
  <div class="wrap">
    <div class="kicker">Honest limits</div>
    <h2>What Griffin can't do</h2>
    <ul>
      <li>Griffin is a server key. If it goes down, agent moves stop, your funds don't: the owner dismisses Griffin and signs alone.</li>
      <li>The hard wall is the limits. Inside them, a bad route through an allowed program could still lose value. Keep limits to what you'd accept losing in a day.</li>
      <li>Each agent move opens a proposal that holds about 0.004 SOL of rent from the agent key. A passed move closes it and the rent goes back to the vault.</li>
      <li>Very long Jupiter routes may not fit one Solana transaction through Squads.</li>
      <li>Griffin has not been audited. Start small.</li>
    </ul>
  </div>
</section>
<section style="padding-top:0">
  <div class="wrap faq">
    <div class="kicker">FAQ</div>
    <h2>Questions</h2>
    <details><summary>Can Griffin take my funds?</summary><p>No. Griffin's key is a vote-only member. It can't propose or execute a move, and one vote is never enough. The worst a broken Griffin can do is vote yes on a move your agent proposed, inside a charter you signed.</p></details>
    <details><summary>What if the agent key leaks?</summary><p>Whoever has it gets the agent's powers and no more: proposals that Griffin judges against your charter. Swap the agent key from the app in one transaction.</p></details>
    <details><summary>What if Griffin disappears?</summary><p>Dismiss it from the app. You are the config authority, so it takes one transaction and no vote. The wallet then answers to your key alone.</p></details>
    <details><summary>Why Squads?</summary><p>Squads v4 is the multisig most Solana teams already trust with treasury funds. Your funds sit in a Squads vault, not in anything we wrote.</p></details>
    <details><summary>Does it cost anything?</summary><p>Guarding a wallet is free. You pay Solana fees and the proposal rent, which comes back to the vault when a move passes.</p></details>
    <details><summary>Is the code open?</summary><p>Yes: the policy engine, the worker, the agent kit and the site. <a href="#" data-github target="_blank" rel="noopener">GitHub</a>.</p></details>
    ${around('/limits/')}
  </div>
</section>`,
  },

  '/token/': {
    title: '$GRIFFIN · GRIFFIN',
    description: "GRIFFIN's token on pump.fun. Guarding a wallet stays free; creator fees pay for the server, RPC and an audit.",
    body: `${banner('/token/', 'VI', '$GRIFFIN', "The project's token. Guarding a wallet stays free.")}
<section class="token">
  <div class="wrap">
    <div class="kicker">Contract</div>
    <h2>The token</h2>
    <p class="sub">$GRIFFIN launches on pump.fun. Creator fees pay for the Griffin server, the RPC and an audit of the policy engine.</p>
    <div class="ca mono" data-ca-big>Contract address comes at launch.</div>
    <div class="btns" style="margin-top:22px"><a class="btn gold" href="#" data-pump hidden target="_blank" rel="noopener">pump.fun</a><a class="btn" href="#" data-x target="_blank" rel="noopener">X</a></div>
  </div>
</section>
<section><div class="wrap">${around('/token/')}</div></section>`,
  },
};

for (const [path, p] of Object.entries(pages)) {
  const dir = fileURLToPath(new URL(`../site${path}`, import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/index.html`, `${head({ path, ...p })}\n${p.body}\n\n${footer}`);
}
console.log('wrote', Object.keys(pages).join(' '));

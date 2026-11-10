// Shared by every page: links from CONFIG, the contract address, and the gate (tally, lanes, full feed).
(() => {
  const CONFIG = { contract: '', x: 'https://x.com/griffindotfun', github: 'https://github.com/Griffin-Guards/griffin' };
  const short = (k) => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const sol = (l) => { const n = BigInt(l || 0); const w = n / 1000000000n; const p = (n % 1000000000n).toString().padStart(9, '0').replace(/0+$/, ''); return p ? `${w}.${p}` : `${w}`; };
  const ago = (t) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
  const $$ = (q) => document.querySelectorAll(q);

  $$('[data-x]').forEach((a) => { if (CONFIG.x) a.href = CONFIG.x; else a.hidden = true; });
  $$('[data-github]').forEach((a) => { if (CONFIG.github) a.href = CONFIG.github; else a.hidden = true; });
  $$('[data-origin]').forEach((e) => { e.textContent = location.origin; });
  if (CONFIG.contract) {
    $$('[data-ca]').forEach((e) => { e.hidden = false; e.textContent = `CA ${CONFIG.contract}`; });
    $$('[data-ca-big]').forEach((e) => { e.textContent = CONFIG.contract; });
    $$('[data-pump]').forEach((a) => { a.hidden = false; a.href = `https://pump.fun/coin/${CONFIG.contract}`; });
  }
  // close the mobile menu after a tap
  $$('.menu .drop a').forEach((a) => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));

  const tally = $$('[data-n]').length > 0;
  const lanes = $$('[data-lane]').length > 0;
  const feedBox = document.querySelector('[data-feed]');
  if (!tally && !lanes && !feedBox) return;

  let filter = 'all';
  let last = [];
  $$('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $$('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawFeed();
  }));
  function drawFeed() {
    if (!feedBox) return;
    const rows = last.filter((v) => filter === 'all' || v.verdict === filter);
    feedBox.innerHTML = rows.length ? rows.map((v) => `<div class="move ${v.verdict === 'passed' ? 'ok' : 'no'}">
      <div><div class="v">${v.verdict === 'passed' ? 'PASSED' : 'TURNED BACK'}</div><div class="top"><span>${ago(v.at)} ago</span></div></div>
      <div><div class="top"><span>wallet ${short(v.multisig)} · move #${v.index}</span><span>${v.solOut && v.solOut !== '0' ? `${sol(v.solOut)} SOL out` : ''}</span></div>
      <ul>${(v.reasons.length ? v.reasons : ['inside the charter']).map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div></div>`).join('')
      : '<div class="empty">No moves here yet.</div>';
  }
  async function load() {
    try {
      const [feed, stats] = await Promise.all([fetch(`/v1/feed?limit=${feedBox ? 100 : 40}`).then((r) => r.json()), fetch('/v1/stats').then((r) => r.json())]);
      for (const k of ['passed', 'turnedBack', 'wallets']) $$(`[data-n="${k}"]`).forEach((e) => { e.textContent = stats[k] ?? 0; });
      last = feed.verdicts || [];
      for (const lane of ['passed', 'turned back']) {
        const box = document.querySelector(`[data-lane="${lane}"]`);
        const rows = last.filter((v) => v.verdict === lane).slice(0, Number(box?.dataset.max || 8));
        if (!box || !rows.length) continue;
        box.innerHTML = rows.map((v) => `<div class="move"><div class="top"><span>${short(v.multisig)} #${v.index}</span><span>${v.solOut !== '0' ? `${sol(v.solOut)} SOL · ` : ''}${ago(v.at)} ago</span></div><div class="why">${esc(v.reasons[0] || '')}${v.reasons.length > 1 ? ` <span style="opacity:.6">+${v.reasons.length - 1} more</span>` : ''}</div></div>`).join('');
      }
      drawFeed();
    } catch { /* the gate stays on its placeholder */ }
  }
  load();
  setInterval(load, 20000);
})();

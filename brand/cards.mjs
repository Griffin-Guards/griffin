// Link preview (1200x630) for the Robinhood Chain site: a move as a receipt next to the navy head.
// Run: node cards.mjs -> ../site/og-image.png
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const NAVY = '#16213a', DEEP = '#0d1424', CREAM = '#f4ead6', PAPER = '#f6f2e8', INK = '#0d1220', GOLD = '#f2a531', OK = '#2f7a4f', MUTE = '#5d6475';
const SERIF = 'Georgia, serif', MONO = 'Consolas, monospace';
const head = readFileSync(new URL('./head-b.svg', import.meta.url), 'utf8').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const rows = [['to', '0xA11c…e5 (listed)'], ['value', '0.05 ETH'], ['griffin', 'signed ✓'], ['charter', 'inside ✓']];
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="${NAVY}"/>
  <rect y="0" width="1200" height="8" fill="${GOLD}"/>
  <svg x="70" y="70" width="92" height="92" viewBox="0 0 400 400"><rect width="400" height="400" rx="60" fill="${DEEP}"/>${head}</svg>
  <text x="182" y="128" font-family="${MONO}" font-weight="700" font-size="26" letter-spacing="6" fill="${CREAM}">GRIFFIN</text>
  <text x="182" y="156" font-family="${MONO}" font-size="16" letter-spacing="4" fill="#9aa3b8">ROBINHOOD CHAIN</text>
  <text x="70" y="290" font-family="${SERIF}" font-size="64" fill="${CREAM}">A Safe for your agent.</text>
  <text x="70" y="370" font-family="${SERIF}" font-size="64" fill="${GOLD}">The charter lives</text>
  <text x="70" y="446" font-family="${SERIF}" font-size="64" fill="${GOLD}">on chain.</text>
  <text x="70" y="560" font-family="${MONO}" font-size="22" letter-spacing="4" fill="#9aa3b8">SAFE + GRIFFINMODULE · AI AGENTS</text>
  <g transform="translate(790 150)"><rect width="340" height="330" fill="${PAPER}"/>
    <text x="24" y="44" font-family="${MONO}" font-weight="700" font-size="18" fill="${INK}">MOVE #7</text>
    <line x1="24" x2="316" y1="62" y2="62" stroke="#cfc8b6" stroke-dasharray="5 5"/>
    ${rows.map(([k, v], i) => `<text x="24" y="${100 + i * 40}" font-family="${MONO}" font-size="17" fill="${MUTE}">${k}</text><text x="316" y="${100 + i * 40}" text-anchor="end" font-family="${MONO}" font-size="17" fill="${v.includes('✓') ? OK : INK}">${v}</text>`).join('')}
    <line x1="24" x2="316" y1="268" y2="268" stroke="#cfc8b6" stroke-dasharray="5 5"/>
    <text x="24" y="304" font-family="${MONO}" font-weight="700" font-size="18" fill="${INK}">STATUS</text><text x="316" y="304" text-anchor="end" font-family="${MONO}" font-weight="700" font-size="18" fill="${OK}">EXECUTED</text></g></svg>`;
await sharp(Buffer.from(og)).png().toFile('../site/og-image.png');
console.log('wrote ../site/og-image.png');

// X header (1500x500): same receipt, the avatar sits over the lower left
const header = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500"><rect width="1500" height="500" fill="${NAVY}"/><rect width="1500" height="8" fill="${GOLD}"/>
  <text x="90" y="150" font-family="${SERIF}" font-size="62" fill="${CREAM}">Your agent spends.</text>
  <text x="90" y="228" font-family="${SERIF}" font-size="62" fill="${GOLD}">The contract keeps count.</text>
  <text x="92" y="292" font-family="${MONO}" font-size="20" letter-spacing="4" fill="#9aa3b8">SAFE + GRIFFINMODULE · ROBINHOOD CHAIN</text>
  <g transform="translate(1080 70)"><rect width="340" height="330" fill="${PAPER}"/>
    <text x="24" y="44" font-family="${MONO}" font-weight="700" font-size="18" fill="${INK}">MOVE #7</text>
    <line x1="24" x2="316" y1="62" y2="62" stroke="#cfc8b6" stroke-dasharray="5 5"/>
    ${rows.map(([k, v], i) => `<text x="24" y="${100 + i * 40}" font-family="${MONO}" font-size="17" fill="${MUTE}">${k}</text><text x="316" y="${100 + i * 40}" text-anchor="end" font-family="${MONO}" font-size="17" fill="${v.includes('✓') ? OK : INK}">${v}</text>`).join('')}
    <line x1="24" x2="316" y1="268" y2="268" stroke="#cfc8b6" stroke-dasharray="5 5"/>
    <text x="24" y="304" font-family="${MONO}" font-weight="700" font-size="18" fill="${INK}">STATUS</text><text x="316" y="304" text-anchor="end" font-family="${MONO}" font-weight="700" font-size="18" fill="${OK}">EXECUTED</text></g></svg>`;
await sharp(Buffer.from(header)).png().toFile('x-header.png');
const avatar = await sharp('avatar.png').resize(200, 200).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="100"/></svg>'), blend: 'dest-in' }]).png().toBuffer();
await sharp('x-header.png').extend({ bottom: 120, background: '#ffffff' }).composite([{ input: avatar, left: 30, top: 400 }]).png().toFile('header-preview.png');
console.log('wrote x-header.png, header-preview.png');

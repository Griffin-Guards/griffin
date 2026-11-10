// X header (1500x500) and link preview (1200x630) in the site's look: ink sky, gules wall, the gate, the head on a shield.
// Run: node cards.mjs -> x-header.png, header-preview.png (with the avatar where X puts it), ../site/og-image.png
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const GULES = '#7a1b1b', GULES_D = '#5c1212', CREAM = '#f4ead6', INK = '#16110e', GOLD = '#f2a531', SAND = '#b9ab98';
const SERIF = 'Georgia, serif', MONO = 'Consolas, monospace';
const head = readFileSync(new URL('./head-a.svg', import.meta.url), 'utf8').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const wall = (w, y) => { let p = `M0 ${y}`; for (let x = 0; x < w; x += 80) p += ` H${x + 40} V${y - 26} H${x + 80} V${y}`; return `<path d="${p} V2000 H0 Z" fill="${GULES}"/>`; };
// a gate tower with the portcullis half down and the shield over the arch
const tower = (x, y, s = 1) => {
  let bars = '';
  for (let i = 0; i < 7; i++) bars += `<rect x="${12 + i * 34}" y="-200" width="8" height="300" fill="${SAND}"/><path d="M${12 + i * 34} 100 L${16 + i * 34} 116 L${20 + i * 34} 100 Z" fill="${SAND}"/>`;
  for (let j = 0; j < 5; j++) bars += `<rect x="0" y="${-130 + j * 50}" width="240" height="7" fill="${SAND}"/>`;
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="-40" y="-150" width="320" height="560" fill="${GULES_D}"/>
    ${[0, 1, 2, 3].map((i) => `<rect x="${-40 + i * 89}" y="-180" width="52" height="32" fill="${GULES_D}"/>`).join('')}
    <path d="M0 410 V120 A120 120 0 0 1 240 120 V410 Z" fill="#0d0a08"/>
    <clipPath id="arch"><path d="M0 410 V120 A120 120 0 0 1 240 120 V410 Z"/></clipPath>
    <g clip-path="url(#arch)"><g transform="translate(0 130)">${bars}</g></g>
    <g transform="translate(55 -120)"><path d="M0 0 H130 V96 L65 140 L0 96 Z" fill="${CREAM}"/>
      <svg x="7" y="4" width="116" height="116" viewBox="0 0 400 400"><clipPath id="sh"><path d="M0 0 H400 V290 L200 400 L0 290 Z"/></clipPath><g clip-path="url(#sh)">${head}</g></svg></g></g>`;
};

const header = `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500"><rect width="1500" height="500" fill="${INK}"/>
  ${wall(1500, 420)}${tower(1170, 190, 0.9)}
  <text x="90" y="130" font-family="${SERIF}" font-weight="700" font-size="58" fill="${CREAM}">Your agent holds one key.</text>
  <text x="90" y="202" font-family="${SERIF}" font-weight="700" font-size="58" fill="${GOLD}">Griffin holds the other.</text>
  <text x="92" y="262" font-family="${MONO}" font-size="19" letter-spacing="3" fill="${SAND}">POLICY CO-SIGNER FOR AI AGENT WALLETS</text>
  <text x="92" y="294" font-family="${MONO}" font-size="19" letter-spacing="3" fill="${SAND}">SOLANA · SQUADS 2 OF 3</text></svg>`;

const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="${INK}"/>
  ${wall(1200, 540)}${tower(870, 260, 0.95)}
  <text x="70" y="110" font-family="${MONO}" font-size="22" letter-spacing="6" fill="${GOLD}">GRIFFIN</text>
  <text x="70" y="220" font-family="${SERIF}" font-weight="700" font-size="60" fill="${CREAM}">Your agent holds</text>
  <text x="70" y="290" font-family="${SERIF}" font-weight="700" font-size="60" fill="${CREAM}">one key.</text>
  <text x="70" y="370" font-family="${SERIF}" font-weight="700" font-size="60" fill="${GOLD}">Griffin holds</text>
  <text x="70" y="440" font-family="${SERIF}" font-weight="700" font-size="60" fill="${GOLD}">the other.</text>
  <text x="70" y="600" font-family="${MONO}" font-size="24" letter-spacing="4" fill="${CREAM}">GRIFFINGUARD.FUN</text></svg>`;

await sharp(Buffer.from(header)).png().toFile('x-header.png');
await sharp(Buffer.from(og)).png().toFile('../site/og-image.png');
// how X shows it: the round avatar sits over the lower left of the header
const avatar = await sharp('avatar.png').resize(200, 200).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="100"/></svg>'), blend: 'dest-in' }]).png().toBuffer();
await sharp('x-header.png').extend({ bottom: 120, background: '#ffffff' }).composite([{ input: avatar, left: 30, top: 400 }]).png().toFile('header-preview.png');
console.log('wrote x-header.png, header-preview.png, ../site/og-image.png');

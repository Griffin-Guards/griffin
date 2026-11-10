// the griffin head on a few tiles; node head.js -> head-<k>.svg, head-sheet.png, small48.png
const sharp = require('sharp');
const fs = require('fs');
const head = ({ tile, cream = '#f4ead6', ink = '#16110e', accent = '#f2a531' }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="${tile}"/>
  <path d="M138 430 C140 380 146 330 140 292 C130 280 128 266 132 252 L150 212 C152 178 170 146 204 128 C226 116 248 112 268 116 L284 34 L318 132 C340 150 352 176 356 204 L392 222 L360 236 L398 266 L362 274 L404 316 L366 318 L412 372 L410 430 Z" fill="${cream}"/>
  <path d="M160 168 C130 166 98 174 76 194 C56 212 48 240 56 270 C60 282 66 288 70 290 C70 270 76 252 90 242 C104 234 122 236 138 246 L156 252 C148 230 150 196 160 168 Z" fill="${accent}"/>
  <path d="M70 290 C66 276 68 258 80 248 C92 240 110 242 124 250 C112 252 100 258 92 268 C84 276 76 284 70 290 Z" fill="${ink}" opacity="0"/>
  <path d="M174 176 L252 158 L248 176 L184 190 Z" fill="${ink}"/>
  <circle cx="224" cy="198" r="15" fill="${ink}"/>
  <circle cx="229" cy="194" r="4.5" fill="${cream}"/>
</svg>`;
const tiles = { a: '#7a1b1b', b: '#16213a', c: '#1f3b2c' };
(async () => {
  const pngs = [];
  for (const [k, tile] of Object.entries(tiles)) {
    const svg = head({ tile });
    fs.writeFileSync(`head-${k}.svg`, svg);
    pngs.push(await sharp(Buffer.from(svg)).resize(300, 300).png().toBuffer());
    pngs.push(await sharp(Buffer.from(svg)).resize(48, 48).resize(300, 300, { kernel: 'nearest' }).png().toBuffer());
  }
  await sharp({ create: { width: 1860, height: 320, channels: 3, background: '#ffffff' } })
    .composite(pngs.map((input, i) => ({ input, left: 10 + i * 310, top: 10 }))).png().toFile('head-sheet.png');
})();

// Bundles app-src/app.js (viem and the core inside) into site/app/app.js as one IIFE. node app-src/build.mjs
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
  entryPoints: [fileURLToPath(new URL('./app.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../site/app/app.js', import.meta.url)),
  bundle: true, format: 'iife', minify: true, target: 'es2020', platform: 'browser', logLevel: 'warning',
});
console.log('built site/app/app.js');

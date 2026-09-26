// Save every StonkFun JS chunk (home, launch, a token page) so the site logic can be read offline.
import { get, save } from './lib.mjs';
const base = 'https://www.stonkfun.xyz';
const seen = new Set();
for (const p of ['/', '/launch', '/token/HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7', '/docs', '/pairs', '/quotes', '/custom-quote']) {
  const r = await get(base + p, { json: false });
  console.log(p, r.status, r.text ? r.text.length : 0);
  if (!r.text) continue;
  for (const m of r.text.matchAll(/["']([^"']*\/_next\/static\/[^"']+\.js[^"']*)["']/g)) seen.add(new URL(m[1], base).href);
}
// build manifest lists every route's chunks
for (const s of [...seen]) {
  if (!/_buildManifest|_ssgManifest/.test(s)) continue;
  const r = await get(s, { json: false });
  for (const m of (r.text || '').matchAll(/"(static\/[^"]+\.js)"/g)) seen.add(`${base}/_next/${m[1]}`);
}
let n = 0;
for (const s of seen) {
  const r = await get(s, { json: false });
  if (r.text) { save('sf_' + s.split('/').pop().split('?')[0], r.text); n++; }
}
console.log('saved', n, 'of', seen.size);

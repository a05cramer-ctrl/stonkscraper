// Quick look: StonkFun's internal quote list (the site's launch page), API docs, Sunrise listings.
import { get, save } from './lib.mjs';
const R = {};
const hdr = (h) => h && Object.fromEntries(Object.entries(h).filter(([k]) => /cache|age|etag|modified|date|x-vercel|ratelimit|content-type/.test(k)));
const eps = {
  qt: 'https://www.stonkfun.xyz/api/quote-tokens',
  lq: 'https://www.stonkfun.xyz/api/launch-quote',
  live: 'https://www.stonkfun.xyz/api/live-config',
  openapi: 'https://www.stonkfun.xyz/api/public/v1/openapi.json',
  custom: 'https://www.stonkfun.xyz/api/custom-quote-token',
  pairsFresh: `https://www.stonkfun.xyz/api/public/v1/pairs?nocache=${Date.now()}`,
  sunTokens: 'https://sunrise.xyz/api/tokens',
  sunBanner: 'https://sunrise.xyz/api/banner',
};
for (const [k, u] of Object.entries(eps)) {
  const r = await get(u);
  R[k] = { url: u, status: r.status, h: hdr(r.headers), len: r.text ? r.text.length : 0, head: (r.text || r.error || '').slice(0, 3000) };
  if (r.json) save(`q_${k}.json`, r.json); else if (r.text) save(`q_${k}.txt`, r.text.slice(0, 300000));
  console.log(k, r.status, r.text ? r.text.length : 0);
}
// the Sunrise chunks that hold the listings fetch
const home = await get('https://sunrise.xyz/tokens', { json: false });
const scripts = [...new Set([...(home.text || '').matchAll(/"([^"]+\.js[^"]*)"/g)].map((m) => new URL(m[1], 'https://sunrise.xyz').href))];
for (const s of scripts) {
  const r = await get(s, { json: false });
  if (!r.text) continue;
  if (/visibleFrom|sunriseLaunchDate|listings|\/api\/tokens/.test(r.text)) save('sunchunk_' + s.split('/').pop().split('?')[0], r.text);
}
save('quick.json', R);
console.log('done');

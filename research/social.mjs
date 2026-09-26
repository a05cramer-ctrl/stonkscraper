// Public announcement channels: do Sunrise / StonkFun post upcoming listings before they go live?
import { get, save } from './lib.mjs';
const R = {};
for (const [k, u] of Object.entries({
  sunriseTg: 'https://t.me/s/sunrise_defi',
  stonkTg: 'https://t.me/s/stonkfunxyz',
  bpAssets: 'https://api.backpack.exchange/api/v1/assets',
  bpMarkets: 'https://api.backpack.exchange/api/v1/markets',
})) {
  const r = await get(u, { json: !k.endsWith('Tg') });
  R[k] = { status: r.status, len: r.text ? r.text.length : 0 };
  if (r.text) save(`${k}.${k.endsWith('Tg') ? 'html' : 'json'}`, r.text);
  console.log(k, r.status, r.text ? r.text.length : 0);
}
// older Telegram posts: page back with ?before=<id>
for (const ch of ['sunrise_defi', 'stonkfunxyz']) {
  let html = '';
  let before = '';
  for (let p = 0; p < 12; p++) {
    const r = await get(`https://t.me/s/${ch}${before ? '?before=' + before : ''}`, { json: false });
    if (!r.text) break;
    html += r.text;
    const ids = [...r.text.matchAll(/data-post="[^/]+\/(\d+)"/g)].map((m) => +m[1]);
    if (!ids.length) break;
    const min = Math.min(...ids);
    if (String(min) === before) break;
    before = String(min);
  }
  save(`tg_${ch}_all.html`, html);
}
save('social.json', R);
console.log('done');

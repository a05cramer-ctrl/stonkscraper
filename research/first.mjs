// First StonkFun launch per quote (oldest token on each pair), 5 at a time within the 300/min limit.
import { get, save, sleep, SF, et } from './lib.mjs';

const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);
const pairs = (await get(`${SF}/pairs?_=${Date.now()}`)).json.data.pairs;
save('pairs.json', pairs);
const out = {};
let idx = 0, done = 0, calls = 0;
const t0 = Date.now();
async function worker() {
  while (idx < pairs.length) {
    const p = pairs[idx++];
    // stay under ~250 requests/minute
    while (calls / Math.max(1, (Date.now() - t0) / 60000) > 250) await sleep(200);
    calls++;
    const r = await get(`${SF}/tokens?quoteMint=${p.mint}&sort=oldest&pageSize=1`, { timeout: 60000 });
    const d = r.json && r.json.data;
    const t = d && d.tokens && d.tokens[0];
    out[p.mint] = { sym: p.symbol, name: p.name, cat: p.category, ready: p.launchLabReady, first: t ? t.createdAt : null, firstSym: t ? t.symbol : null, firstMint: t ? t.mint : null, firstPool: t ? t.pool : null, total: d && d.pagination ? d.pagination.total : null, status: r.status };
    if (++done % 50 === 0) { log(done, '/', pairs.length); save('first_launch.json', out); }
  }
}
await Promise.all([worker(), worker(), worker(), worker(), worker()]);
save('first_launch.json', out);
const recent = Object.entries(out).filter(([, v]) => v.first && Date.parse(v.first) > Date.now() - 21 * 864e5)
  .sort((a, b) => Date.parse(b[1].first) - Date.parse(a[1].first))
  .map(([m, v]) => ({ mint: m, sym: v.sym, cat: v.cat, first: v.first, firstET: et(Date.parse(v.first)), total: v.total, firstSym: v.firstSym }));
save('recent.json', recent);
log('recent quotes (21d):', recent.length);
for (const r of recent) log(r.firstET, r.sym, r.cat, r.total);
log('done');

// Stage 2: StonkFun internal endpoints, Sunrise's token list, first launch per quote, config creation txs.
import { get, rpc, save, sleep, SF, KNOWN, describeTx, et } from './lib.mjs';

const R = {};
const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', ...a);
const hdr = (h) => h && Object.fromEntries(Object.entries(h).filter(([k]) => /cache|age|etag|modified|date|x-vercel|ratelimit|content-type/.test(k)));

async function tx1(sig) {
  return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
}

// A) StonkFun internals
async function stonkInternal() {
  const base = 'https://www.stonkfun.xyz';
  const eps = ['/api/quote-tokens', '/api/quote-tokens?all=1', '/api/launch-quote', '/api/live-config', '/api/public/v1/openapi.json', '/api/custom-quote-token', '/api/platform-pools?pageSize=3', '/api/recent-launches', `/api/public/v1/pairs?_=${Date.now()}`, '/api/public/v1/pairs?launchable=false', '/api/public/v1/pairs?includeAll=true'];
  R.internal = {};
  for (const p of eps) {
    const r = await get(base + p);
    R.internal[p] = { status: r.status, h: hdr(r.headers), len: r.text ? r.text.length : 0, head: (r.text || r.error || '').slice(0, 1500) };
    if (r.json) save('sf' + p.replace(/[^a-z0-9]+/gi, '_') + '.json', r.json);
    else if (r.text) save('sf' + p.replace(/[^a-z0-9]+/gi, '_') + '.txt', r.text.slice(0, 200000));
    log('internal', p, r.status, r.text ? r.text.length : 0);
  }
  // the chunks that call them, for reading the logic
  for (const c of ['1vzrdse-4_aaf.js', '1_dhes1qnylx9.js', '3ftbza3an64rt.js']) {
    const home = await get(base + '/', { json: false });
    const m = home.text && home.text.match(new RegExp(`["']([^"']*${c.replace('.', '\\.')}[^"']*)["']`));
    const url = m ? new URL(m[1], base).href : null;
    if (!url) { log('chunk not linked from home', c); continue; }
    const r = await get(url, { json: false });
    if (r.text) save('sfchunk_' + c, r.text);
  }
}

// B) Sunrise
async function sunrise() {
  R.sunrise = {};
  for (const p of ['/api/tokens', '/api/banner', '/api/tokens?includeUpcoming=true']) {
    const r = await get('https://sunrise.xyz' + p);
    R.sunrise[p] = { status: r.status, h: hdr(r.headers), len: r.text ? r.text.length : 0, head: (r.text || r.error || '').slice(0, 2000) };
    if (r.json) save('sunrise' + p.replace(/[^a-z0-9]+/gi, '_') + '.json', r.json);
    log('sunrise', p, r.status, r.text ? r.text.length : 0);
  }
  const home = await get('https://sunrise.xyz/tokens', { json: false });
  const scripts = [...new Set([...(home.text || '').matchAll(/"([^"]+\.js[^"]*)"/g)].map((m) => new URL(m[1], 'https://sunrise.xyz').href))];
  for (const s of scripts) {
    if (!/1i-90ve2r0ix0|08zndqucfpvdn/.test(s)) continue;
    const r = await get(s, { json: false });
    if (r.text) save('sunchunk_' + s.split('/').pop().split('?')[0], r.text);
  }
}

// C) first launch per quote
async function firstLaunches() {
  const pairs = (await get(`${SF}/pairs?_=${Date.now()}`)).json.data.pairs;
  save('pairs_now.json', pairs);
  const out = {};
  let n = 0;
  for (const p of pairs) {
    const r = await get(`${SF}/tokens?quoteMint=${p.mint}&sort=oldest&limit=2`);
    const toks = r.json && r.json.data && r.json.data.tokens || [];
    const total = r.json && r.json.data && r.json.data.pagination && r.json.data.pagination.total;
    out[p.mint] = { sym: p.symbol, cat: p.category, label: p.categoryLabel, ready: p.launchLabReady, launchable: p.launchable, first: toks[0] ? toks[0].createdAt : null, firstMint: toks[0] ? toks[0].mint : null, firstCreator: toks[0] ? toks[0].creator : null, total, status: r.status };
    if (++n % 50 === 0) { log('firstLaunch', n, '/', pairs.length); save('first_launch.json', out); }
    const rem = r.headers && +r.headers['x-ratelimit-remaining'];
    await sleep(rem && rem < 40 ? 3000 : 230);
  }
  save('first_launch.json', out);
  const recent = Object.entries(out).filter(([, v]) => v.first && Date.parse(v.first) > Date.now() - 21 * 864e5).sort((a, b) => Date.parse(a[1].first) - Date.parse(b[1].first));
  R.recent = recent.map(([m, v]) => ({ mint: m, sym: v.sym, cat: v.cat, first: v.first, firstET: et(Date.parse(v.first)), total: v.total }));
  log('recent quotes (21d):', recent.length);
}

// D) RPC: can we read Sept 24 transactions, and find config creation by paging?
async function chain() {
  R.chain = {};
  try { R.chain.zamaCreate = describeTx(await tx1(KNOWN.ZAMA.createTx)); } catch (e) { R.chain.zamaCreateErr = String(e); }
  log('zama create', !!R.chain.zamaCreate, R.chain.zamaCreateErr || '');
  try {
    const s = await rpc('getSignaturesForAddress', [KNOWN.ZAMA.config, { limit: 5 }]);
    R.chain.zamaCfgNewest = s;
    const t = await tx1(s[0].signature);
    R.chain.zamaCfgNewestTx = describeTx(t);
  } catch (e) { R.chain.zamaCfgErr = String(e); }
}

for (const [name, fn] of Object.entries({ chain, stonkInternal, sunrise, firstLaunches })) {
  try { await fn(); } catch (e) { R['err_' + name] = String(e && e.stack || e); log('ERR', name, e); }
  save('probe2.json', R);
}
log('done');

// Stage 1: learn the shape of every data source and grab the small stuff.
import { get, rpc, tx, describeTx, save, SF, KNOWN, PLATFORM, LAUNCHER, parseMint, configPda } from './lib.mjs';

const R = {};
const keysOf = (o, depth = 0) => (o && typeof o === 'object' && depth < 3 ? Object.fromEntries(Object.entries(Array.isArray(o) ? { '0': o[0] } : o).map(([k, v]) => [k, v && typeof v === 'object' ? keysOf(v, depth + 1) : typeof v])) : typeof o);

async function stonk() {
  const probes = {
    pairs: `${SF}/pairs`,
    stats: `${SF}/stats`,
    tokens: `${SF}/tokens?limit=3`,
    tokensNewest: `${SF}/tokens?sort=newest&limit=3`,
    tokensOldest: `${SF}/tokens?sort=oldest&limit=3`,
    tokensZamaOldest: `${SF}/tokens?quoteMint=${KNOWN.ZAMA.mint}&sort=oldest&limit=3`,
    tokensZamaNewest: `${SF}/tokens?quoteMint=${KNOWN.ZAMA.mint}&sort=newest&limit=3`,
    launches: `${SF}/launches?limit=3`,
    launchesSince: `${SF}/launches?since=2026-09-24T14:50:00Z&limit=5`,
    totalAssets: 'https://www.stonkfun.xyz/api/public/total-assets',
  };
  const full = {};
  for (const [k, u] of Object.entries(probes)) {
    const r = await get(u);
    full[k] = r.json;
    R['sf_' + k] = { url: u, status: r.status, headers: r.headers, shape: keysOf(r.json), sample: r.json ? JSON.stringify(r.json).slice(0, 3000) : (r.text || r.error || '').slice(0, 800) };
    if (k === 'pairs' && r.json) save('pairs.json', r.json);
  }
  // one token detail
  try {
    const t = full.tokensNewest || {};
    const list = t.data?.tokens || t.tokens || t.data || t;
    const mint = Array.isArray(list) && list[0] && (list[0].mint || list[0].address || list[0].id);
    if (mint) { const r = await get(`${SF}/tokens/${mint}`); R.sf_tokenDetail = { status: r.status, shape: keysOf(r.json), sample: JSON.stringify(r.json).slice(0, 3000) }; }
  } catch (e) { R.sf_tokenDetailErr = String(e); }
}

async function quoteLogos() {
  const mints = { ...Object.fromEntries(Object.entries(KNOWN).map(([k, v]) => [k, v.mint])), PAXG_unlisted: '5GgRAEmv8ZxF2PR5hY72Qs5x1bnQ6UK2RbTPoqJ3wSwW', GO_unlisted: 'D1YZZg9dBZ7AbfknZVbaeVLto36eySwoFYEVhZrD4F4n', junk: '11111111111111111111111111111111' };
  R.quoteLogo = {};
  for (const [k, m] of Object.entries(mints)) {
    const r = await get(`https://www.stonkfun.xyz/api/asset/quote-logo/${m}`, { json: false });
    R.quoteLogo[k] = { status: r.status, len: r.text ? r.text.length : 0, h: r.headers && Object.fromEntries(Object.entries(r.headers).filter(([h]) => /modified|etag|age|date|cache|type|length|location|x-vercel|cf-|server/.test(h))) };
  }
}

// Pull a site's HTML + JS chunks and list every endpoint-looking string.
async function siteScan(base, paths, tag) {
  const scripts = new Set();
  const pages = {};
  for (const p of paths) {
    const r = await get(base + p, { json: false });
    pages[p] = { status: r.status, len: r.text ? r.text.length : 0 };
    if (!r.text) continue;
    for (const m of r.text.matchAll(/(?:src|href)="([^"]+\.js[^"]*)"/g)) scripts.add(new URL(m[1], base).href);
    for (const m of r.text.matchAll(/"(\/_next\/static\/[^"]+\.js)"/g)) scripts.add(new URL(m[1], base).href);
    if (p === paths[0]) save(`${tag}_home.html`, r.text);
  }
  const found = {};
  const kw = /launchLabReady|quote-logo|quoteMint|coming|upcoming|soon|whitelist|approved|pairs|supabase|firebase|convex|pusher|ably|socket|wss:|helius|rpc|graphql|labsapis|sunrise|backpack|listing|schedule/i;
  const ctx = [];
  for (const s of scripts) {
    const r = await get(s, { json: false });
    if (!r.text) continue;
    const f = s.split('/').pop();
    for (const m of r.text.matchAll(/["'`]((?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`\s)]*|\/api\/[^"'`\s)]*)["'`]/gi)) { (found[m[1]] = found[m[1]] || new Set()).add(f); }
    let i = 0;
    for (const m of r.text.matchAll(new RegExp(kw.source, 'gi'))) { if (i++ > 40) break; ctx.push({ f, k: m[0], c: r.text.slice(Math.max(0, m.index - 120), m.index + 160) }); }
  }
  R[tag] = { pages, scripts: [...scripts], endpoints: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, [...v].slice(0, 3)])) };
  save(`${tag}_ctx.json`, ctx);
}

async function jup() {
  R.jup = {};
  for (const [k, v] of Object.entries(KNOWN)) {
    const r = await get(`https://lite-api.jup.ag/tokens/v2/search?query=${v.mint}`);
    R.jup[k] = r.json;
  }
  const v = await get('https://lite-api.jup.ag/tokens/v2/tag?query=verified');
  if (Array.isArray(v.json)) {
    const trim = (t) => ({ id: t.id, sym: t.symbol, name: t.name, liq: t.liquidity, mcap: t.mcap, price: t.usdPrice, created: t.createdAt, fpool: t.firstPool, tags: t.tags, dev: t.dev, lp: t.launchpad, org: t.organicScore, hold: t.holderCount, v24: t.stats24h ? (t.stats24h.buyVolume || 0) + (t.stats24h.sellVolume || 0) : null, audit: t.audit, prog: t.tokenProgram, upd: t.updatedAt, cex: t.cexes });
    save('jup_verified.json', v.json.map(trim));
    save('jup_verified_sample.json', v.json.slice(0, 3));
    R.jupVerified = { n: v.json.length, shape: keysOf(v.json), tags: [...new Set(v.json.flatMap((t) => t.tags || []))], withDev: v.json.filter((t) => t.dev).length, withCreatedAt: v.json.filter((t) => t.createdAt).length, withFirstPool: v.json.filter((t) => t.firstPool && t.firstPool.createdAt).length, launchpads: [...new Set(v.json.map((t) => t.launchpad).filter(Boolean))] };
  } else R.jupVerified = { status: v.status, err: v.error };
}

async function raydium() {
  R.ray = {};
  for (const [k, v] of Object.entries(KNOWN)) {
    const r = await get(`https://api-v3.raydium.io/pools/info/mint?mint1=${v.mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=10&page=1`);
    const rows = r.json && r.json.data && r.json.data.data || [];
    R.ray[k] = rows.map((p) => ({ id: p.id, type: p.type, prog: p.programId, open: p.openTime, tvl: p.tvl, a: p.mintA && p.mintA.symbol, b: p.mintB && p.mintB.symbol, vol24: p.day && p.day.volume, amtA: p.mintAmountA, amtB: p.mintAmountB }));
  }
  const c = await get('https://launch-mint-v1.raydium.io/main/configs');
  R.rayConfigs = c.json;
  const pl = await get(`https://launch-mint-v1.raydium.io/main/platforms`);
  R.rayPlatforms = { status: pl.status, sample: (pl.text || pl.error || '').slice(0, 1500) };
}

async function chain() {
  R.chain = {};
  try { R.chain.zamaCreate = describeTx(await tx(KNOWN.ZAMA.createTx)); } catch (e) { R.chain.zamaCreateErr = String(e); }
  // who created ZAMA's config, and what else that wallet does
  const zt = R.chain.zamaCreate && R.chain.zamaCreate.time;
  R.chain.signers = {};
  for (const w of (R.chain.zamaCreate && R.chain.zamaCreate.signers) || []) {
    const sigs = []; let before;
    for (let p = 0; p < 8; p++) {
      const res = await rpc('getSignaturesForAddress', [w, { limit: 1000, ...(before ? { before } : {}) }]).catch(() => null);
      if (!res || !res.length) break;
      sigs.push(...res); before = res[res.length - 1].signature;
      if (res.length < 1000) break;
    }
    const near = sigs.filter((x) => x.blockTime && zt && Math.abs(x.blockTime * 1000 - zt) < 24 * 36e5);
    const pick = [...sigs.slice(0, 15), ...near.slice(0, 60)];
    const seen = new Set(); const txs = [];
    for (const x of pick) { if (seen.has(x.signature)) continue; seen.add(x.signature); try { txs.push({ sig: x.signature, ...describeTx(await tx(x.signature)) }); } catch (e) { txs.push({ sig: x.signature, err: String(e) }); } }
    R.chain.signers[w] = { count: sigs.length, newest: sigs[0] && sigs[0].blockTime, oldest: sigs.length && sigs[sigs.length - 1].blockTime, sigs: sigs.map((x) => [x.signature, x.blockTime, x.err ? 1 : 0]), txs };
  }
  const accts = [KNOWN.ZAMA.config, KNOWN.ENA.config, KNOWN.APE.config, configPda(KNOWN.MASK.mint), PLATFORM.standard, PLATFORM.reward, ...Object.values(KNOWN).map((v) => v.mint)];
  const res = await rpc('getMultipleAccounts', [accts, { encoding: 'base64' }]);
  R.chain.accounts = accts.map((a, i) => { const v = res.value[i]; return v ? { a, owner: v.owner, len: Buffer.from(v.data[0], 'base64').length, lamports: v.lamports, mint: v.owner.startsWith('Token') ? parseMint(v.data[0]) : undefined, head: Buffer.from(v.data[0], 'base64').subarray(0, 8).toString('hex') } : { a, missing: true }; });
  // raw data of configs and platform configs for layout decoding
  R.chain.raw = Object.fromEntries(accts.slice(0, 6).map((a, i) => [a, res.value[i] ? res.value[i].data[0] : null]));
  for (const [k, a] of Object.entries({ ...PLATFORM, launcher: LAUNCHER })) {
    try {
      const s = await rpc('getSignaturesForAddress', [a, { limit: 25 }]);
      const d = [];
      for (const x of s.slice(0, 6)) d.push(describeTx(await tx(x.signature)));
      R.chain['recent_' + k] = { sigs: s.map((x) => ({ sig: x.signature, t: x.blockTime, err: !!x.err })), txs: d };
    } catch (e) { R.chain['recent_' + k] = String(e); }
  }
}

for (const [name, fn] of Object.entries({ stonk, quoteLogos, jup, raydium, chain })) {
  const t0 = Date.now();
  try { await fn(); } catch (e) { R['err_' + name] = String(e && e.stack || e); }
  console.error(name, Date.now() - t0, 'ms');
  save('probe.json', R);
}
await siteScan('https://www.stonkfun.xyz', ['/', '/launch'], 'stonkSite').catch((e) => (R.err_stonkSite = String(e)));
await siteScan('https://sunrise.xyz', ['/tokens', '/'], 'sunriseSite').catch((e) => (R.err_sunriseSite = String(e)));
save('probe.json', R);
console.error('done');

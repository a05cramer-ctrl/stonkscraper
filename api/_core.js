'use strict';
// One scan = one call of runCheck(). State lives in Upstash Redis. Pings go to ntfy.
const crypto = require('crypto');
const R = require('./_redis');

const STONK_PAIRS = 'https://www.stonkfun.xyz/api/public/v1/pairs';
// Sources that move before StonkFun does
const SUNRISE = 'https://sunrise.xyz/api/tokens';                      // Sunrise listings, with their go-live time
const QUOTE_TOKENS = 'https://www.stonkfun.xyz/api/quote-tokens';       // the launch page's own quote list ("SOON" = adminOnly)
const BACKPACK_ASSETS = 'https://api.backpack.exchange/api/v1/assets';  // Backpack Securities stocks, with deposit/withdraw switches
const SF_TOP = 'https://www.stonkfun.xyz/api/public/v1/tokens?sort=marketCap&pageSize=100';
const RAY_POOLS = (p) => `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=desc&pageSize=1000&page=${p}`;
const RPCS = (process.env.RPC_URLS || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map((s) => s.trim()).filter(Boolean);
const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const MIN_LIQ = 50000; // StonkFun's bar for a quote asset
const WATCH_TVL = process.env.WATCH_NEW_POOL_TVL === undefined ? 500000 : +process.env.WATCH_NEW_POOL_TVL; // 0 = off
const DISCORD = process.env.DISCORD_WEBHOOK || '';
// With a Discord webhook set, phone pings go to Discord only (set NTFY_TOPIC too if you want both).
const NTFY_TOPIC = process.env.NTFY_TOPIC || (DISCORD ? '' : 'stonkq-79e0faf6a664');
const K = { state: 'sqw:state', events: 'sqw:events', run: 'sqw:run', pdas: 'sqw:pdas', lock: 'sqw:lock', fails: 'sqw:fails', test: 'sqw:test', likely: 'sqw:likely' };
// Daily "Likely next" digest to Discord at this New York hour (-1 = off).
const DIGEST_HOUR = process.env.DIGEST_HOUR_ET === undefined ? 9 : +process.env.DIGEST_HOUR_ET;
const LIKELY_N = 40;          // how many "Likely next" rows the board keeps
const LIKELY_EVERY = 10 * 60e3; // re-rank at most this often
const FV = 3;                  // feature version: first scan on a new one records, never pings

// ---------- base58 + Solana PDA (verified against @solana/web3.js) ----------
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return Buffer.from(out);
}
function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const P = (1n << 255n) - 19n;
const modp = (a) => ((a % P) + P) % P;
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = r * b % P; b = b * b % P; e >>= 1n; } return r; }
const D = modp(-121665n * powmod(121666n, P - 2n));
function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = modp(y);
  const y2 = y * y % P;
  const x2 = modp(y2 - 1n) * powmod(modp(D * y2 + 1n), P - 2n) % P;
  if (x2 === 0n) return true;
  return powmod(x2, (P - 1n) / 2n) === 1n;
}
const PROG = b58decode(LAUNCHLAB);
const MARK = Buffer.from('ProgramDerivedAddress');
function configPda(mint) {
  const m = b58decode(mint);
  if (m.length !== 32) throw new Error('bad mint');
  const seeds = [Buffer.from('global_config'), m, Buffer.from([0]), Buffer.from([0, 0])];
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])); h.update(PROG); h.update(MARK);
    const d = h.digest();
    if (!onCurve(d)) return b58encode(d);
  }
  throw new Error('no PDA');
}

// ---------- io ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'user-agent': 'stonk-quote-watcher', ...(opts.headers || {}) }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
async function rpc(method, params) {
  let last;
  for (const url of [...RPCS, ...RPCS]) {
    try {
      const j = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 100));
      return j.result;
    } catch (e) { last = e; await sleep(300); }
  }
  throw last;
}
async function loadPairs() {
  // cache-buster: the plain URL is served from Vercel's CDN, often 1-2 min stale
  const j = await getJson(`${STONK_PAIRS}?fresh=${Math.floor(Date.now() / 15000)}`);
  const list = (j.data && j.data.pairs) || j.pairs || [];
  if (!Array.isArray(list) || list.length < 10) throw new Error('StonkFun pairs list came back empty');
  return list;
}
const isMint = (m) => { try { return typeof m === 'string' && b58decode(m).length === 32; } catch { return false; } };
// Sunrise listings on Solana: mint -> { sym, name, vf (go-live ms), cls, issuer }
async function loadSunrise() {
  const j = await getJson(SUNRISE);
  const out = new Map();
  for (const x of (j.data && j.data.listings) || []) {
    const t = x.token || {}, l = x.listing || {};
    if (t.horizonChainId !== 'solana' || !isMint(t.address) || l.status === 'disabled') continue;
    const vf = Date.parse(l.visibleFrom) || 0;
    const prev = out.get(t.address);
    if (prev && prev.vf && prev.vf <= vf) continue;
    out.set(t.address, { sym: l.displaySymbol || t.symbol || '?', name: l.displayName || t.name || '', vf, cls: t.assetClass || '', issuer: t.issuer || '' });
  }
  if (out.size < 20) throw new Error('Sunrise list came back empty');
  return out;
}
// StonkFun's launch-page quote list. adminOnly = shown as SOON, not open to everyone yet.
async function loadQuoteTokens() {
  const j = await getJson(QUOTE_TOKENS);
  const list = j.quoteTokens || [];
  if (list.length < 10) throw new Error('quote-tokens came back empty');
  return list;
}
// Backpack Securities stocks (the Sunrise stock issuer): which ones have deposits/withdrawals switched on
async function loadBackpack() {
  const j = await getJson(BACKPACK_ASSETS);
  const on = {};
  for (const a of Array.isArray(j) ? j : []) {
    if (!/\.US$/.test(a.symbol || '')) continue;
    for (const t of a.tokens || []) {
      if (t.blockchain !== 'Solana' || !isMint(t.contractAddress)) continue;
      const f = (t.depositEnabled ? 'd' : '') + (t.withdrawEnabled ? 'w' : '');
      if (f) on[t.contractAddress] = [a.symbol.replace(/\.US$/, ''), a.displayName || '', f];
    }
  }
  if (Object.keys(on).length < 10) throw new Error('Backpack asset list came back empty');
  return on;
}
// StonkFun's own biggest launches (a top launch sometimes becomes a quote, like MASK)
async function loadSfTop() {
  const j = await getJson(SF_TOP);
  return ((j.data && j.data.tokens) || []).map((t) => ({ mint: t.mint, sym: t.symbol, name: t.name, mcap: (t.market && t.market.marketCapUsd) || 0, vol: (t.market && t.market.volume24hUsd) || 0, liq: (t.market && t.market.liquidityUsd) || 0, born: Date.parse(t.createdAt) || 0 }));
}
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
const WSOL = 'So11111111111111111111111111111111111111112';
const JUP_VERIFIED = 'https://lite-api.jup.ag/tokens/v2/tag?query=verified';
const MIN_LIQ_JUP = 25000;          // Jupiter-verified tokens with this much liquidity anywhere on Solana
const MIN_LIQ_JUP_YOUNG = 5000;     // ...or this much when the token is under a week old
const YOUNG_JUP_MS = 7 * 864e5;
const UNIVERSE_TTL = 10 * 60e3;     // re-pull the token lists every 10 min; scans in between are quick
const YOUNG_MS = 3 * 864e5;
const liqOf = (i) => i.jup || i.real || i.tvl;

// Real money in a Raydium pool = its USDC/USDT or SOL side, doubled. Fake pools (a pile of an
// imitation token against a few $K of USDC) report a giant TVL; this sees through that.
function realTvl(p, solUsd) {
  const a = p.mintA && p.mintA.address, b = p.mintB && p.mintB.address;
  let v = null;
  if (STABLES.has(b)) v = p.mintAmountB; else if (STABLES.has(a)) v = p.mintAmountA;
  else if (b === WSOL && solUsd) v = p.mintAmountB * solUsd; else if (a === WSOL && solUsd) v = p.mintAmountA * solUsd;
  return v == null || !isFinite(v) ? 0 : Math.round(2 * v);
}
function addPools(m, rows, solUsd) {
  let below = false;
  for (const p of rows) {
    if (!(p.tvl >= MIN_LIQ)) { below = true; continue; }
    const real = realTvl(p, solUsd);
    const opened = +p.openTime > 0 ? +p.openTime * 1000 : 0;
    const dayVol = +(p.day && p.day.volume) || 0;
    for (const [t, o] of [[p.mintA, p.mintB], [p.mintB, p.mintA]]) {
      if (!t || !t.address) continue;
      const e = m.get(t.address) || { sym: t.symbol || '?', name: t.name || '', tvl: 0, vs: '?', real: 0, born: 0 };
      if (p.tvl > e.tvl) { e.tvl = Math.round(p.tvl); e.vs = (o && o.symbol) || '?'; }
      if (real > e.real) e.real = real;
      e.rvol = (e.rvol || 0) + dayVol;
      if (opened && (!e.born || opened < e.born)) e.born = opened;
      m.set(t.address, e);
    }
  }
  return below;
}
// Every token worth checking: Raydium pools with $50K+, plus Jupiter-verified tokens with real
// liquidity anywhere on Solana (ENA's money sat mostly off Raydium, so it was missed before).
let UNI = null; // warm-instance cache
async function loadUniverse() {
  if (UNI && Date.now() - UNI.t < UNIVERSE_TTL) return UNI.map;
  const [jup, ray] = await Promise.all([
    getJson(JUP_VERIFIED).catch(() => null),
    Promise.all([1, 2, 3].map((p) => getJson(RAY_POOLS(p)).catch(() => null))),
  ]);
  const jupOk = Array.isArray(jup);
  if (!ray[0] && !jupOk) throw new Error('Raydium and Jupiter token lists both failed');
  const sol = jupOk ? jup.find((t) => t.id === WSOL) : null;
  const solUsd = (sol && sol.usdPrice) || 0;
  const m = new Map();
  let done = false, more = true;
  for (const j of ray) { if (!j) continue; const d = j.data || {}; done = addPools(m, d.data || [], solUsd) || done; more = !!d.hasNextPage; }
  for (let p = 4; ray[0] && !done && more && p <= 6; p++) {
    const d = (await getJson(RAY_POOLS(p))).data || {};
    done = addPools(m, d.data || [], solUsd); more = !!d.hasNextPage;
  }
  const tNow = Date.now();
  if (jupOk) for (const t of jup) {
    if (!t || !t.id) continue;
    const born = Date.parse((t.firstPool && t.firstPool.createdAt) || t.createdAt || '') || 0;
    // brand-new verified tokens count with less money: new quotes (Sunrise stocks etc.) often start thin
    const young = born && tNow - born < YOUNG_JUP_MS;
    if (!(t.liquidity >= MIN_LIQ_JUP || (young && t.liquidity >= MIN_LIQ_JUP_YOUNG))) continue;
    const s24 = t.stats24h || {};
    const jvol = Math.round((+s24.buyVolume || 0) + (+s24.sellVolume || 0));
    const e = m.get(t.id);
    if (e) { e.jup = Math.round(t.liquidity); if (born && (!e.born || born < e.born)) e.born = born; }
    else m.set(t.id, { sym: t.symbol || '?', name: t.name || '', tvl: Math.round(t.liquidity), vs: '', real: 0, born, jup: Math.round(t.liquidity) });
    const x = m.get(t.id);
    x.jvol = jvol; x.ver = 1;
    const tags = t.tags || [];
    const tg = (tags.includes('stable') ? 's' : '') + (tags.includes('lst') || tags.includes('yield') ? 'l' : '') + (tags.includes('prestocks') || tags.includes('tessera') ? 'p' : '') + (tags.includes('backpack') ? 'b' : '') + (tags.includes('ondo') ? 'o' : '');
    if (tg) x.tg = tg;
    if (+t.mcap > 0) x.mcap = Math.round(+t.mcap);
  }
  if (m.size < 50) throw new Error('token lists came back empty');
  UNI = { t: Date.now(), map: m };
  return m;
}

// ---------- pings ----------
const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n || 0)}`);
const dur = (min) => (min < 90 ? `${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `${(min / 60).toFixed(min < 600 ? 1 : 0)} h` : `${Math.round(min / 1440)} days`);
const rankLine = (ev) => (ev.rank ? `\nWas #${ev.rank} on Likely next.` : '');
function leadText(ev) {
  const L = ev.lead;
  if (!L) return 'No track record for this signal yet. The watcher will learn how early it runs.';
  if (L.sched) return `Expect it on StonkFun in about ${dur(Math.max(1, L.min))} (Sunrise time + the usual few minutes).`;
  if (L.base) return `StonkFun usually lists it about ${dur(L.min)} after this ping (${L.base}).`;
  return `Usually live on StonkFun ${dur(L.min)} after this ping (${L.n} past cases).`;
}
function pingFor(ev) {
  const nm = ev.name && ev.name !== ev.sym ? ` (${ev.name})` : '';
  const link = `https://dexscreener.com/solana/${ev.mint}`;
  const soft = ev.cat === 'custom';
  switch (ev.type) {
    case 'early': return { title: `EARLY: ${ev.sym}`, body: `${ev.why}\n${leadText(ev)}${ev.odds ? `\nStonkFun has listed ${ev.odds.on} of ${ev.odds.of} Sunrise assets.` : ''}${rankLine(ev)}\n${ev.mint}`, prio: 'urgent', tags: 'hourglass_flowing_sand', click: link };
    case 'coming': return { title: `COMING TO STONKFUN: ${ev.sym}`, body: `Raydium just set ${ev.sym}${nm} up as a launch quote. StonkFun doesn't list it yet.\nLiquidity ${usd(ev.tvl)}${ev.vs ? ` vs ${ev.vs}` : ''}${ev.chance != null ? `\nChance StonkFun adds it: ${Math.round(ev.chance * 100)}%` : ''}${ev.early ? `\nEARLY ping came ${dur((ev.t - ev.early) / 6e4)} before this.` : ''}${rankLine(ev)}\n${ev.mint}`, prio: 'urgent', tags: 'rotating_light', click: link };
    case 'added': return { title: `StonkFun added ${ev.sym} - NOT live yet`, body: `${ev.sym}${nm} is on StonkFun's list but can't be launched yet.${rankLine(ev)}\n${ev.mint}`, prio: soft ? 'default' : 'urgent', tags: 'rotating_light', click: link };
    case 'live': return { title: `LIVE on StonkFun: ${ev.sym}`, body: `${ev.sym}${nm} can be launched now.${ev.early ? `\nEARLY ping came ${dur((ev.t - ev.early) / 6e4)} before this.` : ''}${ev.arrived ? `\nIt showed up as Arriving ${Math.max(1, Math.round((ev.t - ev.arrived) / 6e4))} min before this.` : ''}${rankLine(ev)}\n${ev.mint}`, prio: soft ? 'default' : 'urgent', tags: 'green_circle', click: link };
    case 'digest': return { title: ev.title, body: ev.body, prio: 'default', tags: 'crystal_ball', click: ev.click };
    case 'deep': return { title: `New deep pool: ${ev.sym}`, body: `${ev.sym}${nm} has ${usd(ev.tvl)} of real liquidity${ev.vs ? ` vs ${ev.vs}` : ''}. Not on StonkFun, not set up yet. Early, can be noise.\n${ev.mint}`, prio: 'default', tags: 'eyes', click: link };
    case 'start': return { title: 'Quote watcher running', body: ev.body, prio: 'default', tags: 'white_check_mark' };
    case 'test': return { title: 'Test ping', body: 'Pings work.', prio: 'default', tags: 'bell' };
    case 'error': return { title: 'Quote watcher: scans failing', body: ev.body, prio: 'default', tags: 'warning' };
    default: return null;
  }
}
const COLORS = { early: 0xc792ea, coming: 0xffb627, added: 0xffb627, live: 0x43d17a, deep: 0x6fc3ff, digest: 0xc792ea, start: 0x8ea3bb, test: 0x8ea3bb, error: 0xff6b5b };
async function ntfy(p) {
  const headers = { Title: p.title.replace(/[^\x20-\x7e]/g, ''), Priority: p.prio, Tags: p.tags };
  if (p.click) headers.Click = p.click;
  try { await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', body: p.body, headers, signal: AbortSignal.timeout(10000) }); } catch {}
}
async function discord(list) {
  // up to 10 embeds per message; urgent ones @everyone so the phone buzzes
  for (let i = 0; i < list.length; i += 10) {
    const chunk = list.slice(i, i + 10);
    const urgent = chunk.some(([, p]) => p.prio === 'urgent');
    const body = {
      username: 'Quote arrivals',
      content: urgent ? '@everyone' : '',
      allowed_mentions: { parse: urgent ? ['everyone'] : [] },
      embeds: chunk.map(([ev, p]) => ({
        title: p.title,
        description: p.body,
        url: p.click || undefined,
        color: COLORS[ev.type] || 0x8ea3bb,
        timestamp: new Date(ev.t || Date.now()).toISOString(),
      })),
    };
    try {
      const r = await fetch(DISCORD, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      if (r.status === 429) { await sleep(2000); await fetch(DISCORD, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
    } catch {}
    if (i + 10 < list.length) await sleep(600);
  }
}
async function notify(events) {
  const list = events.map((ev) => [ev, pingFor(ev)]).filter(([, p]) => p);
  if (!list.length) return;
  await Promise.all([
    NTFY_TOPIC ? Promise.all(list.map(([, p]) => ntfy(p))) : null,
    DISCORD ? discord(list) : null,
  ]);
}

// ---------- scan ----------
let PDAS = null; // warm-instance cache of mint -> config PDA

async function runCheck() {
  const t0 = Date.now();
  const last = JSON.parse((await R.cmd('GET', K.run)) || 'null');
  if (last && t0 - last.t < 20000) return { skipped: 'ran less than 20s ago', last };
  if ((await R.cmd('SET', K.lock, t0, 'NX', 'EX', 55)) !== 'OK') return { skipped: 'another scan is running' };

  const run = { t: t0, v: FV, errors: [] };
  const events = [];
  let pdaAdded = 0;
  try {
    const [stateRaw, pdaRaw] = await Promise.all([R.cmd('GET', K.state), PDAS ? null : R.cmd('GET', K.pdas)]);
    const S = stateRaw ? JSON.parse(stateRaw) : { initialized: false, pairs: {}, cfg: {}, deep: {} };
    if (!PDAS) PDAS = pdaRaw ? JSON.parse(pdaRaw) : {};
    const before = stateRaw || '';
    const first = !S.initialized;
    const upgrade = S.fv !== FV; // first scan on new features: record what's already there, no pings
    const quiet = first || S.v !== 2 || upgrade;
    const now = Date.now();
    S.early = S.early || {}; // mint -> { t, kind, sym, live } : EARLY pings sent
    S.leads = S.leads || {}; // kind -> minutes from EARLY ping to live, newest last
    S.lr = S.lr || {};       // mint -> rank on the last "Likely next" list
    S.recent = S.recent || []; // quotes that went live lately, for the digest's scorecard

    const uniT = UNI && UNI.t;
    const slow = !S.slowT || now - S.slowT > SLOW_EVERY; // Backpack's list is 2 MB: every 10 min is plenty
    const [pairsRes, poolsRes, sunRes, qtRes, bpRes, topRes] = await Promise.allSettled([
      loadPairs(), loadUniverse(), loadSunrise(), loadQuoteTokens(),
      slow ? loadBackpack() : Promise.resolve(null), slow ? loadSfTop() : Promise.resolve(null),
    ]);
    // side sources: a failure only skips their signals, it doesn't count as a failed scan
    run.warn = [sunRes, qtRes, bpRes, topRes].filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    const sun = sunRes.status === 'fulfilled' ? sunRes.value : null;
    const qt = qtRes.status === 'fulfilled' ? qtRes.value : null;
    if (slow && (bpRes.status === 'fulfilled' || topRes.status === 'fulfilled')) S.slowT = now;
    // Backpack stocks switched on since the last look
    let bpNew = null;
    if (bpRes.status === 'fulfilled' && bpRes.value) {
      const prev = S.bp || null;
      bpNew = {};
      if (prev) for (const [m, v] of Object.entries(bpRes.value)) if (!prev[m] || (v[2].length > prev[m][2].length)) bpNew[m] = v;
      S.bp = bpRes.value;
    }
    if (topRes.status === 'fulfilled' && topRes.value) S.top = topRes.value.filter((t) => t.mcap >= 1e6).slice(0, 40).map((t) => [t.mint, t.sym, Math.round(t.mcap), Math.round(t.vol), Math.round(t.liq), t.born]);

    // 1) StonkFun's list
    if (pairsRes.status === 'fulfilled') {
      for (const p of pairsRes.value) {
        const ready = p.launchable !== false && p.launchLabReady !== false;
        const old = S.pairs[p.mint]; // [sym, ready, everReady, cat, firstSeen (0 = before watch)]
        const arr = S.cfg[p.mint];
        const er = S.early[p.mint];
        const base = { sym: p.symbol, name: p.name || '', mint: p.mint, cat: p.category || '', t: now, arrived: arr && arr.t > 0 ? arr.t : 0, early: er && er.t > 0 ? er.t : 0, rank: S.lr[p.mint] || 0 };
        if (arr && arr.t > 0 && !arr.landed) arr.landed = now;
        let ev = null;
        if (!old && !first) ev = { ...base, type: ready ? 'live' : 'added' };
        else if (old && !old[1] && !old[2] && ready && !first) ev = { ...base, type: 'live' };
        if (ev) events.push(ev);
        if (ev && ev.type === 'live') {
          if (er && !er.live) {
            er.live = now;
            for (const [k, t] of Object.entries(er.st || { [er.kind]: er.t })) {
              if (!(t > 0)) continue;
              const L = (S.leads[k] = S.leads[k] || []); L.push(Math.round((now - t) / 6e4)); if (L.length > 50) L.shift();
            }
          }
          S.recent.push({ sym: p.symbol, mint: p.mint, t: now, rank: base.rank, early: base.early, arrived: base.arrived });
        }
        S.pairs[p.mint] = [p.symbol, ready ? 1 : 0, (old && old[2]) || ready ? 1 : 0, p.category || '', old ? (old[4] || 0) : (first ? 0 : now)];
      }
      run.pairs = pairsRes.value.length;
    } else run.errors.push(pairsRes.reason.message);

    // 2) Raydium pools with $50K+ liquidity -> is a LaunchLab config there for mints StonkFun doesn't list?
    if (poolsRes.status === 'fulfilled') {
      const pools = poolsRes.value;
      run.mints = pools.size;
      const cands = [];
      for (const [m, info] of pools) {
        if (S.pairs[m] || S.cfg[m] || STABLES.has(m) || m === WSOL) continue;
        let fresh = false; // never checked before
        if (PDAS[m] === undefined) { try { PDAS[m] = configPda(m); } catch { PDAS[m] = ''; } pdaAdded++; fresh = true; }
        if (PDAS[m]) cands.push([m, info, fresh]);
        // radar: real money only (fake pools don't count), or a brand-new verified token
        const young = info.born && now - info.born < YOUNG_MS;
        const radarLiq = Math.max(info.real || 0, young ? info.jup || 0 : 0);
        if (WATCH_TVL > 0 && radarLiq >= WATCH_TVL && !S.deep[m]) {
          S.deep[m] = now;
          if (!quiet) events.push({ type: 'deep', sym: info.sym, name: info.name, mint: m, tvl: radarLiq, vs: info.real ? info.vs : '', t: now });
        }
      }
      run.cands = cands.length;
      const chunks = [];
      for (let i = 0; i < cands.length; i += 100) chunks.push(cands.slice(i, i + 100));
      try {
        for (let i = 0; i < chunks.length; i += 4) {
          const res = await Promise.all(chunks.slice(i, i + 4).map((c) => rpc('getMultipleAccounts', [c.map(([m]) => PDAS[m]), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])));
          res.forEach((r, ci) => r.value.forEach((acc, k) => {
            if (!acc || acc.owner !== LAUNCHLAB) return;
            const [m, info, fresh] = chunks[i + ci][k];
            // new = checked before without a setup, or a brand-new token; otherwise it was already sitting there
            const isNew = !quiet && (!fresh || (info.born && now - info.born < YOUNG_MS));
            S.cfg[m] = { sym: info.sym, name: info.name, tvl: liqOf(info), vs: info.vs, t: isNew ? now : 0 };
            if (isNew) events.push({ type: 'coming', sym: info.sym, name: info.name, mint: m, tvl: liqOf(info), vs: info.vs, t: now, early: (S.early[m] && S.early[m].t) || 0, rank: S.lr[m] || 0 });
          }));
        }
      } catch (e) { run.errors.push('Solana RPC: ' + e.message); }
      // how often a token Raydium set up is actually on StonkFun (tokens with $50K+ liquidity)
      let listed = 0;
      for (const m of pools.keys()) { const p = S.pairs[m]; if (p && p[1]) listed++; }
      S.stats = { listed, unlisted: Object.keys(S.cfg).filter((m) => !S.pairs[m]).length };
    } else run.errors.push(poolsRes.reason.message);

    // 3) EARLY: signals that come before StonkFun lists a quote. One ping per token per stage
    // (a later, stronger stage pings again: Backpack switch-on -> Sunrise scheduled -> Sunrise live).
    if (pairsRes.status === 'fulfilled') {
      try {
        const sunStats = sun ? sunriseStats(sun, S) : null;
        for (const c of earlyCandidates({ S, now, sun, qt, bpNew })) {
          // skip what StonkFun has, or what already got a COMING ping (an old, unannounced config doesn't count: MNDE)
          if ((S.pairs[c.mint] && S.pairs[c.mint][2]) || (S.cfg[c.mint] && S.cfg[c.mint].t > 0)) continue;
          const e = S.early[c.mint] || (S.early[c.mint] = { t: 0, kind: c.kind, sym: c.sym, st: {}, q: now });
          if (e.st && e.st[c.kind] !== undefined) continue;
          if (e.st && Object.keys(e.st).some((k) => STAGE[k] >= STAGE[c.kind])) continue;
          (e.st = e.st || {})[c.kind] = quiet ? 0 : now;
          if (quiet) continue;
          if (!(e.t > 0)) { e.t = now; e.kind = c.kind; }
          events.push({ type: 'early', sym: c.sym, name: c.name, mint: c.mint, why: c.why, kind: c.kind, at: c.at || 0, lead: leadFor(S, c.kind, c, now), odds: c.kind.startsWith('sunrise') ? sunStats : null, rank: S.lr[c.mint] || 0, t: now });
        }
      } catch (e) { run.errors.push('early: ' + e.message); }
    }

    // 4) Likely next: re-rank when the token lists were refreshed (every ~10 min)
    let likely = null;
    const moved = events.some((e) => e.type === 'coming' || e.type === 'early' || e.type === 'live');
    if (poolsRes.status === 'fulfilled' && pairsRes.status === 'fulfilled' && (UNI.t !== uniT || moved || !S.lk || now - S.lk > LIKELY_EVERY)) {
      likely = rankLikely(poolsRes.value, S, now, sun);
      S.lk = now;
      S.lr = Object.fromEntries(likely.map((r) => [r.mint, r.rank]));
    }

    // 5) daily digest (the first scan after DIGEST_HOUR New York time)
    let digest = null;
    const ny = nyParts(now);
    if (DIGEST_HOUR >= 0 && ny.hour >= DIGEST_HOUR && S.dg !== ny.date && run.pairs && run.mints) {
      S.dg = ny.date; // one try per day, even if Discord is down
      if (!quiet) digest = { S, likely, ny };
    }

    // tidy: forget radar entries older than 30 days, EARLY entries after 30 days, scorecard after 3 days
    for (const m of Object.keys(S.deep)) if (now - S.deep[m] > 30 * 864e5) delete S.deep[m];
    for (const m of Object.keys(S.early)) { const e = S.early[m]; if (now - (e.t > 0 ? e.t : e.q || now) > 30 * 864e5 || (!(e.t > 0) && S.pairs[m])) delete S.early[m]; }
    S.recent = S.recent.filter((r) => now - r.t < 3 * 864e5);

    if (run.pairs && run.mints) { S.v = 2; S.fv = FV; }
    if (first && run.pairs && run.mints) {
      S.initialized = true;
      const waiting = Object.values(S.cfg).filter((c) => c).length;
      events.push({ type: 'start', t: now, body: `Watching ${run.pairs} StonkFun pairs and ${run.mints} Raydium tokens with real liquidity. ${waiting} already set up by Raydium but not on StonkFun.` });
    }

    const o = odds(S, now);
    for (const ev of events) if (ev.type === 'coming') ev.chance = o.pct;

    if (digest) {
      try {
        const list = digest.likely || JSON.parse((await R.cmd('GET', K.likely)) || '{"list":[]}').list;
        events.push(digestEvent(list, S, now));
      } catch (e) { run.errors.push('digest: ' + e.message); }
    }

    const writes = [];
    const after = JSON.stringify(S);
    if (after !== before) writes.push(R.cmd('SET', K.state, after));
    if (pdaAdded) writes.push(R.cmd('SET', K.pdas, JSON.stringify(PDAS)));
    if (likely) writes.push(R.cmd('SET', K.likely, JSON.stringify({ t: now, list: likely })));
    const logged = events.filter((e) => e.type !== 'digest');
    if (logged.length) {
      const old = JSON.parse((await R.cmd('GET', K.events)) || '[]');
      writes.push(R.cmd('SET', K.events, JSON.stringify([...logged.slice().reverse(), ...old].slice(0, 150))));
    }
    await Promise.all(writes);
    await notify(events);
  } catch (e) {
    run.errors.push(e.message);
  } finally {
    run.ms = Date.now() - t0;
    run.events = events.length;
    run.ok = run.errors.length === 0;
    try {
      await R.cmd('SET', K.run, JSON.stringify(run));
      if (run.ok) await R.cmd('SET', K.fails, 0);
      else if (+(await R.cmd('INCR', K.fails)) === 10) await notify([{ type: 'error', t: Date.now(), body: `Last 10 scans had errors: ${run.errors.join('; ')}` }]);
      await R.cmd('DEL', K.lock);
    } catch {}
  }
  return run;
}

// ---------- New York time ----------
function nyParts(t) {
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour % 24, wd: o.weekday, label: `${o.weekday} ${o.month}/${o.day}` };
}

// ---------- EARLY ----------
const SLOW_EVERY = 10 * 60e3;
const nyClock = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// later stage = closer to live; a token pings again when it reaches a later stage
const STAGE = { 'sf-top': 1, 'backpack-on': 1, 'stonkfun-soon': 2, 'sunrise-scheduled': 2, 'sunrise-live': 3 };
// StonkFun promotes its big launches to quotes; every launch above this market cap is a quote so far
const SF_PROMOTE_MCAP = +(process.env.SF_PROMOTE_MCAP || 5e6);
// Tokens that are about to become StonkFun quotes, from sources that move first.
function earlyCandidates({ S, now, sun, qt, bpNew }) {
  const out = [];
  const listed = (m) => S.pairs[m] && S.pairs[m][2];
  if (sun) for (const [m, x] of sun) {
    if (listed(m) || !x.vf || x.cls === 'stablecoin') continue; // StonkFun skips Sunrise stablecoins (USDv)
    const nm = x.name && x.name !== x.sym ? ` (${x.name.replace(/ - Backpack Securities$/, '')})` : '';
    if (x.vf > now + 60e3) out.push({ mint: m, sym: x.sym, name: x.name, kind: 'sunrise-scheduled', at: x.vf, why: `Sunrise has ${x.sym}${nm} scheduled to go live at ${nyClock(x.vf)} ET.` });
    else if (now - x.vf < 3 * 36e5) out.push({ mint: m, sym: x.sym, name: x.name, kind: 'sunrise-live', at: x.vf, why: `Sunrise put ${x.sym}${nm} live on Solana at ${nyClock(x.vf)} ET.` });
  }
  if (qt) for (const q of qt) if (q.adminOnly && !listed(q.quoteMint)) out.push({ mint: q.quoteMint, sym: q.symbol, name: q.name, kind: 'stonkfun-soon', why: `StonkFun shows ${q.symbol} as SOON on its launch page (admin-only for now).` });
  for (const [m, sym, mcap] of S.top || []) {
    if (listed(m) || mcap < SF_PROMOTE_MCAP || Object.values(S.pairs).some((p) => String(p[0]).toUpperCase() === String(sym).toUpperCase())) continue;
    out.push({ mint: m, sym, name: '', kind: 'sf-top', why: `${sym} is a StonkFun launch at ${usd(mcap)} market cap and not a quote yet. Every StonkFun launch above ${usd(SF_PROMOTE_MCAP)} is a quote so far (MASK, SI, ALLINU got promoted this week).` });
  }
  for (const [m, v] of Object.entries(bpNew || {})) if (!listed(m) && !(sun && sun.has(m))) out.push({ mint: m, sym: v[0], name: v[1], kind: 'backpack-on', why: `Backpack switched on ${v[0]} (${v[1]})${v[2] === 'dw' ? ' for deposits and withdrawals' : v[2] === 'd' ? ' for deposits' : ' for withdrawals'}. Sunrise stocks are Backpack stocks.` });
  return out;
}
// How many Sunrise assets StonkFun has taken so far
function sunriseStats(sun, S) {
  let on = 0; for (const m of sun.keys()) if (S.pairs[m] && S.pairs[m][2]) on++;
  return { on, of: sun.size };
}
// Minutes from this kind of EARLY ping to StonkFun live. Research baseline until the watcher has 3 of its own.
// sunrise-live: Sunrise go-live -> StonkFun live was 2-10 min on the last Sunrise listings (IREN 2, ZAMA 8,
//   SQQQ 10, cbLTC 10), and the ping lands up to 2 min after Sunrise goes live.
// sf-top: StonkFun launches that became quotes had crossed $5M market cap 15 h to 10 days before
//   (WOW 15 h, CRACKER 28 h, SI 98 h, KNOTS 101 h, FEELSGOOD 151 h, ZCAT 207 h, LEVERCAT 240 h).
const BASE_LEAD = {
  'sunrise-live': { min: 6, n: 4, base: 'last 4 Sunrise listings' },
  'sf-top': { min: 101 * 60, n: 7, base: 'the last 7 launches that became quotes, 15 h to 10 days after passing $5M' },
};
function leadFor(S, kind, c, now) {
  const L = (S.leads && S.leads[kind]) || [];
  if (L.length >= 3) { const s = L.slice().sort((a, b) => a - b); return { min: s[Math.floor(s.length / 2)], n: s.length }; }
  if (kind === 'sunrise-scheduled' && c && c.at) return { min: Math.round((c.at - now) / 6e4) + 8, n: 0, sched: 1 };
  return BASE_LEAD[kind] || null;
}

// ---------- Likely next ----------
// Tokens StonkFun doesn't list yet, ranked by how likely they are to be next: Sunrise assets first (StonkFun
// takes almost every one), then Backpack stocks that just got switched on, StonkFun's own top launches
// (MASK went that way), then verified tokens by liquidity, 24 h volume and newness.
function rankLikely(uni, S, now, sun) {
  const listed = (m) => S.pairs[m] && S.pairs[m][2];
  const syms = new Set(Object.values(S.pairs).map((p) => String(p[0] || '').toUpperCase()));
  const rows = new Map();
  const row = (m, sym, name) => {
    let r = rows.get(m);
    if (!r) {
      const i = uni.get(m) || {};
      r = { mint: m, sym: sym || i.sym || '?', name: name || i.name || '', liq: Math.max(i.jup || 0, i.real || 0), vol: Math.max(i.jvol || 0, i.rvol || 0), born: i.born || 0, s: 0, why: [], special: 0, tg: i.tg || '' };
      // Jupiter tags: families StonkFun lists (PreStocks, Tessera, Backpack stocks) vs ones it mostly skips
      if (/p/.test(r.tg)) { r.special += 4; r.why.push('PreStock/Tessera'); }
      if (/b/.test(r.tg)) { r.special += 3; r.why.push('Backpack stock'); }
      rows.set(m, r);
    }
    return r;
  };
  for (const [m, i] of uni) {
    if (listed(m) || STABLES.has(m) || m === WSOL) continue;
    if (!i.ver && !(i.real >= 2 * MIN_LIQ) && !S.cfg[m]) continue; // unverified: only with real money in the pool
    const up = String(i.sym || '').toUpperCase();
    if (syms.has(up) || syms.has(up + 'X')) continue;             // StonkFun already has the ticker, or its xStock twin
    row(m);
  }
  if (sun) for (const [m, x] of sun) {
    if (listed(m)) continue;
    const up = String(x.sym || '').toUpperCase();
    if (syms.has(up) || syms.has(up + 'X')) continue; // StonkFun already has it, or its xStock twin
    const r = row(m, x.sym, x.name);
    if (x.cls === 'stablecoin') { r.special += 1; r.why.push('Sunrise stablecoin'); continue; }
    if (x.vf > now) { r.special += 9; r.why.push(`Sunrise ${nyClock(x.vf)} ET`); }
    else if (now - x.vf < 3 * 864e5) { r.special += 7; r.why.push('new on Sunrise'); }
    else { r.special += 2; r.why.push('Sunrise'); } // older ones StonkFun skipped so far (ENA still got picked up months later)
  }
  for (const [m, v] of Object.entries(S.bp || {})) {
    if (listed(m) || (sun && sun.has(m)) || syms.has(String(v[0]).toUpperCase()) || syms.has(String(v[0]).toUpperCase() + 'X')) continue;
    const r = row(m, v[0], v[1]); r.special += 3; r.why.push('Backpack stock on');
  }
  for (const [m, sym, mcap, vol, liq, born] of S.top || []) {
    if (listed(m) || syms.has(String(sym || '').toUpperCase())) continue; // ticker clash with a quote StonkFun has
    const r = row(m, sym);
    r.liq = Math.max(r.liq, liq || 0); r.vol = Math.max(r.vol, vol || 0); if (!r.born && born) r.born = born;
    // StonkFun promotes its biggest launches to quotes (its top 9 by market cap are all quotes)
    r.special += 2 + 1.5 * Math.max(0, Math.log10(mcap || 1) - 6); r.why.push(`StonkFun launch ${usd(mcap)} mcap`);
  }
  for (const r of rows.values()) {
    const age = r.born ? (now - r.born) / 864e5 : null;
    let s = Math.log10(Math.max(r.liq, 1e3)) + 0.6 * Math.log10(Math.max(r.vol, 1e3)) + r.special;
    if (age !== null && age < 21) s += 3 * Math.exp(-age / 4);
    else if (age !== null && age > 60 && !r.special) s -= 1.5; // big for months and still not listed: StonkFun passed on it
    if (/[sl]/.test(r.tg) && r.special < 5) s -= 4;               // stablecoins and staked SOL: StonkFun rarely adds them
    if (/o/.test(r.tg)) s -= 1;                                    // Ondo stocks: none listed so far
    // a fresh Raydium setup (COMING ping) almost always lands; an old one StonkFun has passed on for a while (MNDE did land)
    if (S.cfg[r.mint]) { if (S.cfg[r.mint].t > 0) { s += 6; r.why.unshift('Raydium set up'); } else { s += 1.5; r.why.unshift('old Raydium setup'); } }
    const e = S.early[r.mint];
    if (e && e.t > 0) { s += 3; r.why.unshift('EARLY'); }
    if (r.vol > 2 * r.liq && r.vol > 1e5) r.why.push('hot volume');
    r.s = Math.round(s * 100) / 100;
    r.why = [...new Set(r.why)].join(' · ');
    delete r.special; delete r.tg;
  }
  return [...rows.values()].sort((a, b) => b.s - a.s).slice(0, LIKELY_N).map((r, k) => ({ ...r, rank: k + 1 }));
}

const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
function digestEvent(list, S, now) {
  const ny = nyParts(now);
  const ageTxt = (b) => (!b ? '' : (now - b) / 864e5 < 1 ? 'new today' : `${Math.round((now - b) / 864e5)}d old`);
  const top = (list || []).slice(0, 15).map((r) => `${r.rank}. [${r.sym}](https://dexscreener.com/solana/${r.mint}) ${usd(r.liq)} liq · ${usd(r.vol)} vol${r.born ? ' · ' + ageTxt(r.born) : ''}${r.why ? ' · ' + r.why : ''}`);
  const went = (S.recent || []).filter((r) => now - r.t < 26 * 36e5).map((r) => `${r.sym} (${r.rank ? '#' + r.rank : 'not on list'}${r.early ? `, EARLY ${dur((r.t - r.early) / 6e4)} ahead` : ''})`);
  const body = `${top.length ? top.join('\n') : 'Nothing ranked yet.'}\n\nWent live in the last 24 h: ${went.length ? went.join(', ') : 'none'}`;
  return { type: 'digest', t: now, title: `Likely next · ${ny.label}`, body, click: SITE || undefined };
}

// Chance StonkFun adds a fresh arrival. Until 5 arrivals have had 3 days to play out, use the base rate
// (share of Raydium-set-up tokens that StonkFun lists); after that, use the watcher's own track record.
const COLD_MS = 72 * 36e5;
function odds(S, now) {
  const st = S.stats || { listed: 0, unlisted: 0 };
  const base = st.listed + st.unlisted ? st.listed / (st.listed + st.unlisted) : null;
  const fresh = Object.values(S.cfg).filter((c) => c && c.t > 0);
  const done = fresh.filter((c) => c.landed || now - c.t > COLD_MS);
  const landed = fresh.filter((c) => c.landed);
  const own = done.length >= 5 ? done.filter((c) => c.landed).length / done.length : null;
  const hrs = landed.map((c) => (c.landed - c.t) / 36e5).sort((a, b) => a - b);
  return { pct: own !== null ? own : base, basis: own !== null ? 'own' : 'base', listed: st.listed, unlisted: st.unlisted, arrived: fresh.length, landed: landed.length, decided: done.length, medianHours: hrs.length ? hrs[Math.floor(hrs.length / 2)] : null };
}

async function getState() {
  const [stateRaw, eventsRaw, runRaw, likelyRaw] = await R.cmd('MGET', K.state, K.events, K.run, K.likely);
  const S = stateRaw ? JSON.parse(stateRaw) : { pairs: {}, cfg: {}, deep: {} };
  const now = Date.now();
  const L = likelyRaw ? JSON.parse(likelyRaw) : null;
  const early = Object.entries(S.early || {})
    .filter(([m, e]) => e.t > 0 && !S.pairs[m])
    .map(([mint, e]) => ({ mint, sym: e.sym, kind: e.kind, t: e.t, setUp: !!S.cfg[mint] }))
    .sort((a, b) => b.t - a.t);
  const leads = Object.fromEntries(Object.keys(S.leads || {}).map((k) => [k, leadFor(S, k)]));
  const o = odds(S, now);
  // only things that showed up after the watch started
  const arriving = Object.entries(S.cfg)
    .filter(([m, c]) => c && c.t > 0 && !S.pairs[m])
    .map(([mint, c]) => ({ mint, ...c, cold: now - c.t > COLD_MS }))
    .sort((a, b) => b.t - a.t);
  const boarding = Object.entries(S.pairs)
    .filter(([, p]) => !p[1] && p[4] > 0)
    .map(([mint, p]) => ({ mint, sym: p[0], cat: p[3], t: p[4] }))
    .sort((a, b) => b.t - a.t);
  return {
    now,
    run: runRaw ? JSON.parse(runRaw) : null,
    initialized: !!S.initialized,
    pairCount: Object.keys(S.pairs).length,
    arriving,
    boarding,
    // already sitting there when the watch started
    oldArriving: Object.entries(S.cfg)
      .filter(([m, c]) => c && !(c.t > 0) && !S.pairs[m])
      .map(([mint, c]) => ({ mint, ...c }))
      .sort((a, b) => b.tvl - a.tvl),
    oldBoarding: Object.entries(S.pairs)
      .filter(([, p]) => !p[1] && !(p[4] > 0))
      .map(([mint, p]) => ({ mint, sym: p[0], cat: p[3] })),
    odds: o,
    early,
    leads,
    likely: L ? L.list : [],
    likelyAt: L ? L.t : 0,
    digestHour: DIGEST_HOUR,
    pingTo: [NTFY_TOPIC && 'ntfy', DISCORD && 'Discord'].filter(Boolean),
    events: eventsRaw ? JSON.parse(eventsRaw).slice(0, 80) : [],
  };
}

// ?what=digest sends today's "Likely next" digest right away (same as the daily one).
async function testPing(what) {
  if ((await R.cmd('SET', K.test, 1, 'NX', 'EX', 30)) !== 'OK') return { skipped: 'wait 30s between test pings' };
  if (what === 'digest') {
    const [stateRaw, likelyRaw] = await R.cmd('MGET', K.state, K.likely);
    const S = stateRaw ? JSON.parse(stateRaw) : { recent: [] };
    const L = likelyRaw ? JSON.parse(likelyRaw) : { list: [] };
    await notify([digestEvent(L.list, S, Date.now())]);
    return { sent: 'digest', rows: L.list.length, to: [NTFY_TOPIC && 'ntfy', DISCORD && 'discord'].filter(Boolean) };
  }
  await notify([{ type: 'test', t: Date.now() }]);
  return { sent: true, to: [NTFY_TOPIC && 'ntfy', DISCORD && 'discord'].filter(Boolean) };
}

module.exports = { runCheck, getState, testPing, configPda, onCurve, b58encode, rankLikely };

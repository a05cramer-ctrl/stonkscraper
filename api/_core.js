'use strict';
// One scan = one call of runCheck(). State lives in Upstash Redis. Pings go to ntfy.
const crypto = require('crypto');
const R = require('./_redis');

const STONK_PAIRS = 'https://www.stonkfun.xyz/api/public/v1/pairs';
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
  const j = await getJson(STONK_PAIRS);
  const list = (j.data && j.data.pairs) || j.pairs || [];
  if (!Array.isArray(list) || list.length < 10) throw new Error('StonkFun pairs list came back empty');
  return list;
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
    if (+t.mcap > 0) x.mcap = Math.round(+t.mcap);
  }
  if (m.size < 50) throw new Error('token lists came back empty');
  UNI = { t: Date.now(), map: m };
  return m;
}

// ---------- pings ----------
const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const dur = (min) => (min < 90 ? `${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `${(min / 60).toFixed(min < 600 ? 1 : 0)} h` : `${Math.round(min / 1440)} days`);
const rankLine = (ev) => (ev.rank ? `\nWas #${ev.rank} on Likely next.` : '');
function pingFor(ev) {
  const nm = ev.name && ev.name !== ev.sym ? ` (${ev.name})` : '';
  const link = `https://dexscreener.com/solana/${ev.mint}`;
  const soft = ev.cat === 'custom';
  switch (ev.type) {
    case 'early': return { title: `EARLY: ${ev.sym}`, body: `${ev.why}${ev.lead ? `\nUsually live on StonkFun ${dur(ev.lead.min)} after this ping (${ev.lead.n} past cases).` : ''}${ev.tvl ? `\nLiquidity ${usd(ev.tvl)}` : ''}${rankLine(ev)}\n${ev.mint}`, prio: 'urgent', tags: 'hourglass_flowing_sand', click: link };
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

  const run = { t: t0, errors: [] };
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
    const [pairsRes, poolsRes] = await Promise.allSettled([loadPairs(), loadUniverse()]);

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
          if (er && er.t > 0 && !er.live) { er.live = now; const L = (S.leads[er.kind] = S.leads[er.kind] || []); L.push(Math.round((now - er.t) / 6e4)); if (L.length > 50) L.shift(); }
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

    // 3) EARLY: signals that come before Raydium's setup
    if (poolsRes.status === 'fulfilled' && pairsRes.status === 'fulfilled') {
      try {
        for (const c of await earlyCandidates({ S, uni: poolsRes.value, pairs: pairsRes.value, now })) {
          if (S.early[c.mint] || S.pairs[c.mint] || S.cfg[c.mint]) continue;
          S.early[c.mint] = { t: quiet ? 0 : now, kind: c.kind, sym: c.sym };
          if (!quiet) events.push({ type: 'early', sym: c.sym, name: c.name, mint: c.mint, tvl: c.tvl || 0, why: c.why, kind: c.kind, lead: leadFor(S, c.kind), rank: S.lr[c.mint] || 0, t: now });
        }
      } catch (e) { run.errors.push('early: ' + e.message); }
    }

    // 4) Likely next: re-rank when the token lists were refreshed (every ~10 min)
    let likely = null;
    const moved = events.some((e) => e.type === 'coming' || e.type === 'early' || e.type === 'live');
    if (poolsRes.status === 'fulfilled' && pairsRes.status === 'fulfilled' && (UNI.t !== uniT || moved || !S.lk || now - S.lk > LIKELY_EVERY)) {
      likely = rankLikely(poolsRes.value, S, now);
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
    for (const m of Object.keys(S.early)) if (S.early[m].t > 0 ? now - S.early[m].t > 30 * 864e5 : S.pairs[m]) delete S.early[m];
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
// Each producer returns [{ mint, sym, name, kind, why, tvl }] for tokens that are likely to become a
// StonkFun quote soon. Filled in from the listing research.
async function earlyCandidates() { return []; }
// Typical minutes from an EARLY ping to live, per signal kind, from the research on past listings.
const BASE_LEAD = {};
function leadFor(S, kind) {
  const L = (S.leads && S.leads[kind]) || [];
  if (L.length >= 3) { const s = L.slice().sort((a, b) => a - b); return { min: s[Math.floor(s.length / 2)], n: s.length }; }
  return BASE_LEAD[kind] || null;
}

// ---------- Likely next ----------
// Verified tokens with real liquidity that StonkFun doesn't list, ranked by liquidity, volume and newness.
function rankLikely(uni, S, now) {
  const listedSyms = new Set(Object.values(S.pairs).map((p) => String(p[0] || '').toUpperCase()));
  const rows = [];
  for (const [m, i] of uni) {
    if (S.pairs[m] || STABLES.has(m) || m === WSOL) continue;
    if (!i.ver && !(i.real >= 2 * MIN_LIQ) && !S.cfg[m]) continue; // unverified: only with real money in the pool
    if (listedSyms.has(String(i.sym || '').toUpperCase())) continue; // copies of tickers StonkFun already has
    const liq = Math.max(i.jup || 0, i.real || 0);
    const vol = Math.max(i.jvol || 0, i.rvol || 0);
    const age = i.born ? (now - i.born) / 864e5 : null;
    let s = Math.log10(Math.max(liq, 1e3)) + 0.6 * Math.log10(Math.max(vol, 1e3));
    const why = [];
    if (age !== null && age < 21) s += 3 * Math.exp(-age / 4);
    else if (age !== null && age > 60) s -= 1.5; // big for months and still not listed: StonkFun passed on it
    if (S.cfg[m]) { s += 6; why.push('Raydium set up'); }
    if (S.early[m] && S.early[m].t > 0) { s += 3; why.push(S.early[m].kind); }
    if (vol > 2 * liq && vol > 1e5) why.push('hot volume');
    rows.push({ mint: m, sym: i.sym, name: i.name, liq, vol, born: i.born || 0, s: Math.round(s * 100) / 100, why: why.join(' · ') });
  }
  rows.sort((a, b) => b.s - a.s);
  return rows.slice(0, LIKELY_N).map((r, k) => ({ ...r, rank: k + 1 }));
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

module.exports = { runCheck, getState, testPing, configPda, onCurve, b58encode };

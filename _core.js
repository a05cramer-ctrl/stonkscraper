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
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'stonkq-79e0faf6a664';
const K = { state: 'sqw:state', events: 'sqw:events', run: 'sqw:run', pdas: 'sqw:pdas', lock: 'sqw:lock', fails: 'sqw:fails', test: 'sqw:test' };

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
function addPools(m, rows) {
  let below = false;
  for (const p of rows) {
    if (!(p.tvl >= MIN_LIQ)) { below = true; continue; }
    for (const [t, o] of [[p.mintA, p.mintB], [p.mintB, p.mintA]]) {
      if (!t || !t.address) continue;
      const e = m.get(t.address);
      if (!e || e.tvl < p.tvl) m.set(t.address, { sym: t.symbol || '?', name: t.name || '', tvl: Math.round(p.tvl), vs: (o && o.symbol) || '?' });
    }
  }
  return below;
}
async function loadPools() {
  const m = new Map();
  const first = await Promise.all([1, 2, 3].map((p) => getJson(RAY_POOLS(p)).catch(() => null)));
  if (!first[0]) throw new Error('Raydium pool list failed');
  let done = false, more = true;
  for (const j of first) { if (!j) continue; const d = j.data || {}; done = addPools(m, d.data || []) || done; more = !!d.hasNextPage; }
  for (let p = 4; !done && more && p <= 6; p++) {
    const d = (await getJson(RAY_POOLS(p))).data || {};
    done = addPools(m, d.data || []); more = !!d.hasNextPage;
  }
  if (m.size < 50) throw new Error('Raydium pool list came back empty');
  return m;
}

// ---------- pings ----------
const usd = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
function pingFor(ev) {
  const nm = ev.name && ev.name !== ev.sym ? ` (${ev.name})` : '';
  const link = `https://dexscreener.com/solana/${ev.mint}`;
  const soft = ev.cat === 'custom';
  switch (ev.type) {
    case 'coming': return { title: `COMING TO STONKFUN: ${ev.sym}`, body: `Raydium just set ${ev.sym}${nm} up as a launch quote. StonkFun doesn't list it yet.\nLiquidity ${usd(ev.tvl)} vs ${ev.vs}\n${ev.mint}`, prio: 'urgent', tags: 'rotating_light', click: link };
    case 'added': return { title: `StonkFun added ${ev.sym} - NOT live yet`, body: `${ev.sym}${nm} is on StonkFun's list but can't be launched yet.\n${ev.mint}`, prio: soft ? 'default' : 'urgent', tags: 'rotating_light', click: link };
    case 'live': return { title: `LIVE on StonkFun: ${ev.sym}`, body: `${ev.sym}${nm} can be launched now.\n${ev.mint}`, prio: soft ? 'default' : 'urgent', tags: 'green_circle', click: link };
    case 'deep': return { title: `New deep pool: ${ev.sym}`, body: `${ev.sym}${nm} has ${usd(ev.tvl)} on Raydium vs ${ev.vs}. Not on StonkFun, not set up yet. Early, can be noise.\n${ev.mint}`, prio: 'default', tags: 'eyes', click: link };
    case 'start': return { title: 'Quote watcher running', body: ev.body, prio: 'default', tags: 'white_check_mark' };
    case 'test': return { title: 'Test ping', body: 'Pings work.', prio: 'default', tags: 'bell' };
    case 'error': return { title: 'Quote watcher: scans failing', body: ev.body, prio: 'default', tags: 'warning' };
    default: return null;
  }
}
async function ntfy(ev) {
  const p = pingFor(ev);
  if (!p || !NTFY_TOPIC) return;
  const headers = { Title: p.title.replace(/[^\x20-\x7e]/g, ''), Priority: p.prio, Tags: p.tags };
  if (p.click) headers.Click = p.click;
  try { await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY_TOPIC), { method: 'POST', body: p.body, headers, signal: AbortSignal.timeout(10000) }); } catch {}
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
    const now = Date.now();

    const [pairsRes, poolsRes] = await Promise.allSettled([loadPairs(), loadPools()]);

    // 1) StonkFun's list
    if (pairsRes.status === 'fulfilled') {
      for (const p of pairsRes.value) {
        const ready = p.launchable !== false && p.launchLabReady !== false;
        const old = S.pairs[p.mint]; // [sym, ready, everReady, cat]
        const base = { sym: p.symbol, name: p.name || '', mint: p.mint, cat: p.category || '', t: now };
        if (!old && !first) events.push({ ...base, type: ready ? 'live' : 'added' });
        else if (old && !old[1] && !old[2] && ready && !first) events.push({ ...base, type: 'live' });
        S.pairs[p.mint] = [p.symbol, ready ? 1 : 0, (old && old[2]) || ready ? 1 : 0, p.category || ''];
      }
      run.pairs = pairsRes.value.length;
    } else run.errors.push(pairsRes.reason.message);

    // 2) Raydium pools with $50K+ liquidity -> is a LaunchLab config there for mints StonkFun doesn't list?
    if (poolsRes.status === 'fulfilled') {
      const pools = poolsRes.value;
      run.mints = pools.size;
      const cands = [];
      for (const [m, info] of pools) {
        if (S.pairs[m] || S.cfg[m]) continue;
        if (PDAS[m] === undefined) { try { PDAS[m] = configPda(m); } catch { PDAS[m] = ''; } pdaAdded++; }
        if (PDAS[m]) cands.push([m, info]);
        if (WATCH_TVL > 0 && info.tvl >= WATCH_TVL && !S.deep[m]) {
          S.deep[m] = now;
          if (!first) events.push({ type: 'deep', sym: info.sym, name: info.name, mint: m, tvl: info.tvl, vs: info.vs, t: now });
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
            const [m, info] = chunks[i + ci][k];
            S.cfg[m] = { sym: info.sym, name: info.name, tvl: info.tvl, vs: info.vs, t: first ? 0 : now };
            if (!first) events.push({ type: 'coming', sym: info.sym, name: info.name, mint: m, tvl: info.tvl, vs: info.vs, t: now });
          }));
        }
      } catch (e) { run.errors.push('Solana RPC: ' + e.message); }
    } else run.errors.push(poolsRes.reason.message);

    // tidy: forget radar entries older than 30 days
    for (const m of Object.keys(S.deep)) if (now - S.deep[m] > 30 * 864e5) delete S.deep[m];

    if (first && run.pairs && run.mints) {
      S.initialized = true;
      const waiting = Object.values(S.cfg).filter((c) => c).length;
      events.push({ type: 'start', t: now, body: `Watching ${run.pairs} StonkFun pairs and ${run.mints} Raydium tokens with $50K+ liquidity. ${waiting} already set up by Raydium but not on StonkFun.` });
    }

    const writes = [];
    const after = JSON.stringify(S);
    if (after !== before) writes.push(R.cmd('SET', K.state, after));
    if (pdaAdded) writes.push(R.cmd('SET', K.pdas, JSON.stringify(PDAS)));
    if (events.length) {
      const old = JSON.parse((await R.cmd('GET', K.events)) || '[]');
      writes.push(R.cmd('SET', K.events, JSON.stringify([...events.slice().reverse(), ...old].slice(0, 150))));
    }
    await Promise.all(writes);
    await Promise.all(events.map(ntfy));
  } catch (e) {
    run.errors.push(e.message);
  } finally {
    run.ms = Date.now() - t0;
    run.events = events.length;
    run.ok = run.errors.length === 0;
    try {
      await R.cmd('SET', K.run, JSON.stringify(run));
      if (run.ok) await R.cmd('SET', K.fails, 0);
      else if (+(await R.cmd('INCR', K.fails)) === 10) await ntfy({ type: 'error', body: `Last 10 scans had errors: ${run.errors.join('; ')}` });
      await R.cmd('DEL', K.lock);
    } catch {}
  }
  return run;
}

async function getState() {
  const [stateRaw, eventsRaw, runRaw] = await R.cmd('MGET', K.state, K.events, K.run);
  const S = stateRaw ? JSON.parse(stateRaw) : { pairs: {}, cfg: {}, deep: {} };
  const arriving = Object.entries(S.cfg)
    .filter(([m]) => !S.pairs[m])
    .map(([mint, c]) => ({ mint, ...c }))
    .sort((a, b) => (b.t - a.t) || (b.tvl - a.tvl));
  const boarding = Object.entries(S.pairs)
    .filter(([, p]) => !p[1])
    .map(([mint, p]) => ({ mint, sym: p[0], cat: p[3] }));
  return {
    now: Date.now(),
    run: runRaw ? JSON.parse(runRaw) : null,
    initialized: !!S.initialized,
    pairCount: Object.keys(S.pairs).length,
    arriving,
    boarding,
    events: eventsRaw ? JSON.parse(eventsRaw).slice(0, 80) : [],
  };
}

async function testPing() {
  if ((await R.cmd('SET', K.test, 1, 'NX', 'EX', 30)) !== 'OK') return { skipped: 'wait 30s between test pings' };
  await ntfy({ type: 'test' });
  return { sent: true };
}

module.exports = { runCheck, getState, testPing, configPda, onCurve, b58encode };

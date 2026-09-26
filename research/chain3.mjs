// Stage 3c: exact pre-listing activity. Reads each mint's history backwards from the go-live moment
// (so the bot flood after listing is skipped), and finds when Raydium created the LaunchLab config.
import { get, rpc, save, sleep, describeTx, configPda, et, b58decode } from './lib.mjs';

const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);
const isMint = (m) => { try { return b58decode(m).length === 32; } catch { return false; } };
const R = { items: [] };

const tip = await rpc('getSlot', [{ commitment: 'finalized' }]);
const tipT = (await rpc('getBlockTime', [tip])) * 1000;
const btCache = new Map();
async function blockTime(slot) {
  if (btCache.has(slot)) return btCache.get(slot);
  let v = null; try { v = (await rpc('getBlockTime', [slot])) * 1000; } catch {}
  btCache.set(slot, v); return v;
}
async function slotAt(t) {
  let s = Math.round(tip - (tipT - t) / 400);
  for (let i = 0; i < 8; i++) {
    let bt = await blockTime(s), k = 0;
    while (bt == null && k++ < 6) { s += 1; bt = await blockTime(s); }
    if (bt == null) return s;
    if (Math.abs(t - bt) < 1200) return s;
    s += Math.round((t - bt) / 400);
  }
  return s;
}
const anchorCache = new Map();
async function anchorSig(t) {
  const key = Math.round(t / 30000);
  if (anchorCache.has(key)) return anchorCache.get(key);
  let s = await slotAt(t), a = null;
  for (let k = 0; k < 10 && !a; k++, s++) {
    try {
      const b = await rpc('getBlock', [s, { transactionDetails: 'signatures', maxSupportedTransactionVersion: 1, rewards: false, commitment: 'finalized' }]);
      if (b && b.signatures && b.signatures.length) a = { sig: b.signatures[0], slot: s, t: b.blockTime * 1000 };
    } catch {}
  }
  anchorCache.set(key, a); return a;
}
async function txAny(sig) { return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); }
function classify(d) {
  if (!d) return 'null';
  const names = new Set();
  for (const ix of d.ixs) {
    if (ix.what && !ix.what.startsWith('d:')) names.add(ix.what);
    else if (ix.prog) names.add(ix.prog.slice(0, 6) + ':' + (ix.what || '').slice(2, 10));
  }
  for (const l of d.logs || []) { const m = l.match(/Instruction: (\w+)/); if (m) names.add(m[1]); }
  return [...names].slice(0, 14).join(',');
}
async function readBack(addr, fromT, toT, maxPages) {
  const a = await anchorSig(toT);
  if (!a) return { err: 'no anchor' };
  const out = []; let before = a.sig, pages = 0, reachedStart = false;
  while (pages < maxPages) {
    let res;
    try { res = await rpc('getSignaturesForAddress', [addr, { limit: 1000, before }]); } catch (e) { return { err: String(e).slice(0, 120), out, pages }; }
    pages++;
    if (!res.length) { reachedStart = true; break; }
    for (const s of res) if (s.blockTime && s.blockTime * 1000 >= fromT && s.blockTime * 1000 <= toT) out.push(s);
    before = res[res.length - 1].signature;
    if (res.length < 1000) { reachedStart = true; break; }
    if (res[res.length - 1].blockTime * 1000 < fromT) break;
  }
  out.sort((x, y) => x.blockTime - y.blockTime);
  return { out, pages, reachedStart, anchorT: a.t };
}
async function exists(addr, t) {
  const a = await anchorSig(t);
  if (!a) return null;
  try { const r = await rpc('getSignaturesForAddress', [addr, { limit: 1, before: a.sig }]); return r.length > 0; } catch { return null; }
}

// ---- items ----
const sun = (await get('https://sunrise.xyz/api/tokens')).json.data.listings;
const first = (await get('https://raw.githubusercontent.com/a05cramer-ctrl/stonkscraper/research/research/runs/36270835122-first/first_launch.json')).json || {};
const pings = { '72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1': 1790199356099, '4Zp52aF4hZi9fzH19xpbWKYKQvgLyCN67KFbrQDqeTKh': 1790261861746, 'RENzhrJQgmAnfcLhU1U5XwAMc6TC15UA6jCbPBaasnj': 1790280140258, 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs': 1790301736735, 'SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE': 1790347236326, 'cbLTC4T5NpzSUtQ7ekgEMZGaUPVJY1ko6BUikqa4gGf': 1790358034913, 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey': 1790359266610, 'HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7': 1790398230701 };
const items = [];
for (const x of sun) {
  const m = x.token.address;
  if (!isMint(m) || !first[m]) continue; // only ones StonkFun lists
  const vf = Date.parse(x.listing.visibleFrom);
  if (vf < Date.parse('2026-09-08T00:00:00Z')) continue;
  items.push({ sym: x.listing.displaySymbol, mint: m, kind: 'sunrise-' + x.token.assetClass, t0: vf, live: pings[m] || null, firstLaunch: first[m].first ? Date.parse(first[m].first) : null });
}
items.push({ sym: 'EWY', mint: 'EWY4owSJYMpwN33qGDu5gGxpkQkpMJu8ZUsQJaNZG5dv', kind: 'sunrise-stock', t0: Date.parse('2026-09-26T15:00:00Z'), live: null, firstLaunch: Date.parse('2026-09-26T15:04:26Z') });
for (const [m, t] of Object.entries(pings)) if (!items.find((i) => i.mint === m)) items.push({ sym: (first[m] && first[m].sym) || m.slice(0, 5), mint: m, kind: 'custom', t0: t, live: t, firstLaunch: first[m] && first[m].first ? Date.parse(first[m].first) : null });
items.sort((a, b) => b.t0 - a.t0);
log('items', items.length);

async function one(it) {
  const t1 = Date.now();
  // a) the mint in the 24 h before go-live
  const pre = await readBack(it.mint, it.t0 - 24 * 36e5, it.t0, 8);
  const list = pre.out || [];
  it.pre = { n: list.length, pages: pre.pages, reachedStart: pre.reachedStart, err: pre.err };
  it.preFirst = list[0] ? { et: et(list[0].blockTime * 1000), leadMin: Math.round((it.t0 - list[0].blockTime * 1000) / 6e4) } : null;
  it.preTx = [];
  const pick = list.length <= 16 ? list : [...list.slice(0, 8), ...list.slice(-8)];
  for (const x of pick) {
    try { const d = describeTx(await txAny(x.signature)); it.preTx.push({ et: et(x.blockTime * 1000), leadMin: Math.round((it.t0 - x.blockTime * 1000) / 6e4), err: !!x.err, signers: d ? d.signers.map((w) => w.slice(0, 8)) : [], what: classify(d) }); } catch (e) { it.preTx.push({ et: et(x.blockTime * 1000), e: String(e).slice(0, 60) }); }
  }
  // b) config creation: first minute (relative to go-live) at which the config has any history
  const cfg = configPda(it.mint);
  const ks = [-120, -60, -30, -15, -8, -4, -2, 0, 1, 2, 3, 4, 6, 8, 12, 20, 30, 60, 120];
  let prevK = null, foundK = null;
  for (const k of ks) {
    const e = await exists(cfg, it.t0 + k * 60e3);
    if (e) { foundK = k; break; }
    prevK = k;
  }
  if (foundK !== null) {
    const lo = prevK === null ? it.t0 - 7 * 864e5 : it.t0 + prevK * 60e3;
    const rb = await readBack(cfg, lo, it.t0 + foundK * 60e3, 40);
    const o = rb.out && rb.out[0];
    it.cfg = { foundK, reachedStart: rb.reachedStart, n: rb.out ? rb.out.length : 0 };
    if (o) {
      it.cfg.et = et(o.blockTime * 1000); it.cfg.minVsT0 = Math.round((o.blockTime * 1000 - it.t0) / 6e4 * 10) / 10;
      try { const d = describeTx(await txAny(o.signature)); it.cfg.signers = d && d.signers; it.cfg.what = classify(d); } catch {}
    }
  } else it.cfg = { none: true };
  it.t0ET = et(it.t0); it.liveET = it.live ? et(it.live) : null; it.firstLaunchET = it.firstLaunch ? et(it.firstLaunch) : null;
  R.items.push(it);
  log(it.sym.padEnd(6), it.kind.padEnd(16), 't0', it.t0ET, '| pre24h', it.pre.n, it.preFirst ? `first ${it.preFirst.leadMin}m before` : '', '| cfg', it.cfg.et || 'none', it.cfg.minVsT0 !== undefined ? `(${it.cfg.minVsT0} min vs t0)` : '', (it.cfg.signers || []).map((s) => s.slice(0, 8)).join(','), '|', ((Date.now() - t1) / 1000).toFixed(0) + 's');
}

let idx = 0;
async function worker() { while (idx < items.length) { const it = items[idx++]; try { await one(it); } catch (e) { log('ERR', it.sym, String(e).slice(0, 150)); } save('chain3.json', R); } }
await Promise.all([worker(), worker(), worker()]);
save('chain3.json', R);
log('done');

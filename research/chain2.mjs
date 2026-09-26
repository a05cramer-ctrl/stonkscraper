// Stage 3b: what happens on-chain in the hours before each listing, reading backwards from the listing
// moment (anchor signature taken from the block at that time) instead of paging through all later trades.
import { get, rpc, save, sleep, describeTx, configPda, et, b58decode, SF } from './lib.mjs';

const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);
const isMint = (m) => { try { return b58decode(m).length === 32; } catch { return false; } };
const R = { items: [] };

// ---- slot <-> time ----
const tip = await rpc('getSlot', [{ commitment: 'finalized' }]);
const tipT = (await rpc('getBlockTime', [tip])) * 1000;
async function blockTime(slot) { try { return (await rpc('getBlockTime', [slot])) * 1000; } catch { return null; } }
async function slotAt(t) {
  let s = Math.round(tip - (tipT - t) / 400);
  for (let i = 0; i < 6; i++) {
    let bt = await blockTime(s);
    let k = 0; while (bt == null && k++ < 5) { s += 1; bt = await blockTime(s); }
    if (bt == null) break;
    const d = Math.round((t - bt) / 400);
    if (Math.abs(t - bt) < 1500) break;
    s += d;
  }
  return s;
}
async function anchorSig(t) {
  let s = await slotAt(t);
  for (let k = 0; k < 8; k++, s++) {
    try {
      const b = await rpc('getBlock', [s, { transactionDetails: 'signatures', maxSupportedTransactionVersion: 1, rewards: false, commitment: 'finalized' }]);
      if (b && b.signatures && b.signatures.length) return { sig: b.signatures[b.signatures.length - 1], slot: s, t: b.blockTime * 1000 };
    } catch {}
  }
  return null;
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
// signatures of `addr` in [from, to], reading backwards from the block at `to`
async function sigsBetween(addr, from, to, maxPages = 30) {
  const a = await anchorSig(to);
  if (!a) return { err: 'no anchor' };
  const out = []; let before = a.sig, pages = 0, reachedStart = false;
  while (pages < maxPages) {
    let res;
    try { res = await rpc('getSignaturesForAddress', [addr, { limit: 1000, before }]); } catch (e) { return { err: String(e).slice(0, 120), out }; }
    pages++;
    if (!res.length) { reachedStart = true; break; }
    for (const s of res) if (s.blockTime && s.blockTime * 1000 >= from && s.blockTime * 1000 <= to) out.push(s);
    before = res[res.length - 1].signature;
    const ot = res[res.length - 1].blockTime * 1000;
    if (res.length < 1000) { reachedStart = true; break; }
    if (ot < from) break;
  }
  out.sort((x, y) => x.blockTime - y.blockTime);
  return { out, pages, reachedStart, anchor: a };
}

// ---- what to look at ----
const sun = (await get('https://sunrise.xyz/api/tokens')).json.data.listings;
const first = (await get('https://raw.githubusercontent.com/a05cramer-ctrl/stonkscraper/research/research/runs/36270835122-first/first_launch.json')).json || {};
const pings = { '72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1': 1790199356099, '4Zp52aF4hZi9fzH19xpbWKYKQvgLyCN67KFbrQDqeTKh': 1790261861746, 'RENzhrJQgmAnfcLhU1U5XwAMc6TC15UA6jCbPBaasnj': 1790280140258, 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs': 1790301736735, 'SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE': 1790347236326, 'cbLTC4T5NpzSUtQ7ekgEMZGaUPVJY1ko6BUikqa4gGf': 1790358034913, 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey': 1790359266610, 'HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7': 1790398230701 };
const items = [];
for (const x of sun) {
  const m = x.token.address;
  if (!isMint(m)) continue;
  const vf = Date.parse(x.listing.visibleFrom);
  if (vf < Date.parse('2026-09-08T00:00:00Z')) continue;
  items.push({ sym: x.listing.displaySymbol, mint: m, kind: 'sunrise-' + x.token.assetClass, t0: vf, live: pings[m] || null, firstLaunch: first[m] && first[m].first ? Date.parse(first[m].first) : null });
}
for (const [m, t] of Object.entries(pings)) if (!items.find((i) => i.mint === m)) items.push({ sym: (first[m] && first[m].sym) || m.slice(0, 5), mint: m, kind: 'custom', t0: t, live: t, firstLaunch: first[m] && first[m].first ? Date.parse(first[m].first) : null });
// EWY: live today, not in Sunrise's API
items.push({ sym: 'EWY', mint: 'EWY4owSJYMpwN33qGDu5gGxpkQkpMJu8ZUsQJaNZG5dv', kind: 'sunrise-stock?', t0: Date.parse('2026-09-26T15:00:00Z'), live: null, firstLaunch: Date.parse('2026-09-26T15:04:26Z') });
items.sort((a, b) => b.t0 - a.t0);
log('items', items.length);

for (const it of items) {
  const t1 = Date.now();
  const from = it.t0 - 24 * 36e5, to = it.t0 + 10 * 60e3;
  const s = await sigsBetween(it.mint, from, to);
  it.err = s.err; it.pages = s.pages; it.reachedStart = s.reachedStart;
  const list = s.out || [];
  it.n = list.length;
  it.nBefore = list.filter((x) => x.blockTime * 1000 < it.t0).length;
  it.first = list[0] ? { et: et(list[0].blockTime * 1000), leadMin: Math.round((it.t0 - list[0].blockTime * 1000) / 6e4) } : null;
  // decode: first 10 + last 6 before t0
  const pre = list.filter((x) => x.blockTime * 1000 < it.t0);
  const pick = [...list.slice(0, 10), ...pre.slice(-6)];
  const seen = new Set(); it.tx = [];
  for (const x of pick) {
    if (seen.has(x.signature)) continue; seen.add(x.signature);
    try { const d = describeTx(await txAny(x.signature)); it.tx.push({ et: et(x.blockTime * 1000), leadMin: Math.round((it.t0 - x.blockTime * 1000) / 6e4), err: !!x.err, signers: d ? d.signers.map((w) => w.slice(0, 8)) : [], what: classify(d) }); } catch (e) { it.tx.push({ et: et(x.blockTime * 1000), e: String(e).slice(0, 60) }); }
    await sleep(80);
  }
  // StonkFun side: LaunchLab config creation near the listing
  const cfg = configPda(it.mint);
  const c = await sigsBetween(cfg, it.t0 - 48 * 36e5, (it.live || it.firstLaunch || it.t0) + 30 * 60e3, 60);
  const cl = (c.out || []);
  if (cl.length) {
    const o = cl[0];
    it.cfg = { et: et(o.blockTime * 1000), minVsT0: Math.round((o.blockTime * 1000 - it.t0) / 6e4), n: cl.length, reachedStart: c.reachedStart, pages: c.pages };
    try { const d = describeTx(await txAny(o.signature)); it.cfg.signers = d && d.signers; it.cfg.what = classify(d); } catch {}
  } else it.cfg = { none: true, err: c.err, pages: c.pages };
  it.t0ET = et(it.t0); it.liveET = it.live ? et(it.live) : null; it.firstLaunchET = it.firstLaunch ? et(it.firstLaunch) : null;
  R.items.push(it);
  save('chain2.json', R);
  log(it.sym, it.kind, 't0', it.t0ET, 'pre', it.nBefore, 'first', it.first && it.first.leadMin, 'cfg', it.cfg && (it.cfg.minVsT0 ?? 'none'), ((Date.now() - t1) / 1000).toFixed(0) + 's');
}
log('done');

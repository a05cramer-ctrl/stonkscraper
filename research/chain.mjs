// Stage 3: on-chain timeline around each recent Sunrise listing (stock + crypto) and StonkFun config creation.
import { get, rpc, save, sleep, describeTx, configPda, et, parseMint, RPCS, b58decode } from './lib.mjs';
const isMint = (m) => { try { return b58decode(m).length === 32; } catch { return false; } };

const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);
const R = { rpcTest: {}, listings: [] };

async function txAny(sig) {
  return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
}

// 1) which RPCs serve history
const CANDIDATES = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com', 'https://solana.drpc.org'];
const ZAMA_TX = '4pyuMKj3dtDzfLqvZwq5hPmofMVhVsHR7T7223AcgxyeZtnC5ANd89NAzdqKg1hNyyxezvuFqY4A5n1c7qnMNTSA';
for (const u of CANDIDATES) {
  try {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [ZAMA_TX, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }), signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => null);
    R.rpcTest[u] = { status: r.status, ok: !!(j && j.result), err: j && j.error ? JSON.stringify(j.error).slice(0, 200) : null, t: j && j.result ? j.result.blockTime : null };
    if (j && j.result) R.zamaCreate = describeTx(j.result);
  } catch (e) { R.rpcTest[u] = { err: String(e) }; }
}
log('rpc test', JSON.stringify(R.rpcTest));
save('chain.json', R);

// 2) Sunrise listings since Sep 8
const sun = (await get('https://sunrise.xyz/api/tokens')).json;
const pairs = (await get(`https://www.stonkfun.xyz/api/public/v1/pairs?_=${Date.now()}`)).json.data.pairs;
const pm = new Map(pairs.map((p) => [p.mint, p]));
const L = sun.data.listings
  .map((x) => ({ sym: x.listing.displaySymbol, mint: x.token.address, cls: x.token.assetClass, issuer: x.token.issuer, vf: Date.parse(x.listing.visibleFrom), upd: Date.parse(x.listing.updatedAt), onSF: pm.has(x.token.address) }))
  .filter((x) => x.vf > Date.parse('2026-09-08T00:00:00Z') && x.mint && isMint(x.mint))
  .sort((a, b) => b.vf - a.vf);
log('listings to scan', L.length);

// mint accounts (authorities, supply)
for (let i = 0; i < L.length; i += 100) {
  const res = await rpc('getMultipleAccounts', [L.slice(i, i + 100).map((x) => x.mint), { encoding: 'base64' }]);
  res.value.forEach((v, k) => { const x = L[i + k]; if (v) { x.owner = v.owner; x.mintInfo = parseMint(v.data[0]); x.len = Buffer.from(v.data[0], 'base64').length; } });
}

function classify(d) {
  if (!d) return 'null';
  const names = new Set();
  for (const ix of d.ixs) {
    if (ix.what && !ix.what.startsWith('d:')) names.add(ix.what);
    else if (ix.prog) names.add(ix.prog.slice(0, 6) + ':' + (ix.what || '').slice(0, 10));
  }
  for (const l of d.logs || []) { const m = l.match(/Instruction: (\w+)/); if (m) names.add(m[1]); }
  return [...names].slice(0, 12).join(',');
}

for (const x of L) {
  const t1 = Date.now();
  const from = x.vf - 72 * 36e5, to = x.vf + 30 * 60e3;
  const inWin = []; let before, pages = 0, oldest = null, total = 0, done = false;
  while (pages < 80) {
    let res;
    try { res = await rpc('getSignaturesForAddress', [x.mint, { limit: 1000, ...(before ? { before } : {}) }]); } catch (e) { x.err = String(e); break; }
    pages++;
    if (!res.length) { done = true; break; }
    total += res.length;
    for (const s of res) if (s.blockTime && s.blockTime * 1000 >= from && s.blockTime * 1000 <= to) inWin.push(s);
    oldest = res[res.length - 1]; before = oldest.signature;
    if (res.length < 1000) { done = true; break; }
    if (oldest.blockTime && oldest.blockTime * 1000 < from) break;
  }
  x.pages = pages; x.sigsSeen = total; x.reachedStart = done;
  x.oldestSeen = oldest ? { sig: oldest.signature, t: oldest.blockTime * 1000, et: et(oldest.blockTime * 1000) } : null;
  inWin.sort((a, b) => a.blockTime - b.blockTime);
  const pre = inWin.filter((s) => s.blockTime * 1000 < x.vf);
  x.preCount = pre.length;
  x.firstInWindow = inWin[0] ? { t: inWin[0].blockTime * 1000, et: et(inWin[0].blockTime * 1000), leadMin: Math.round((x.vf - inWin[0].blockTime * 1000) / 6e4) } : null;
  // decode the earliest ones in the window
  x.early = [];
  for (const s of inWin.slice(0, 14)) {
    try {
      const d = describeTx(await txAny(s.signature));
      x.early.push({ et: et(s.blockTime * 1000), leadMin: Math.round((x.vf - s.blockTime * 1000) / 6e4), err: !!s.err, signers: d ? d.signers.map((w) => w.slice(0, 8)) : [], what: classify(d) });
    } catch (e) { x.early.push({ et: et(s.blockTime * 1000), err: String(e).slice(0, 80) }); }
    await sleep(120);
  }
  x.vfET = et(x.vf); x.updET = et(x.upd);
  R.listings.push(x);
  save('chain.json', R);
  log(x.sym, 'pages', pages, 'pre', pre.length, 'first', x.firstInWindow && x.firstInWindow.leadMin, 'min', ((Date.now() - t1) / 1000).toFixed(0) + 's');
}

// 3) StonkFun config creation for the newest listed ones (page back to the config's first tx)
R.configs = [];
for (const x of L.filter((y) => y.onSF).slice(0, 14)) {
  const cfg = configPda(x.mint);
  let before, pages = 0, oldest = null, n = 0;
  while (pages < 160) {
    let res;
    try { res = await rpc('getSignaturesForAddress', [cfg, { limit: 1000, ...(before ? { before } : {}) }]); } catch (e) { break; }
    pages++;
    if (!res.length) break;
    n += res.length; oldest = res[res.length - 1]; before = oldest.signature;
    if (res.length < 1000) break;
  }
  const c = { sym: x.sym, mint: x.mint, cfg, pages, n, vf: x.vf, vfET: x.vfET };
  if (oldest && pages < 160) {
    c.createdT = oldest.blockTime * 1000; c.createdET = et(c.createdT); c.minAfterSunrise = Math.round((c.createdT - x.vf) / 6e4); c.sig = oldest.signature;
    try { const d = describeTx(await txAny(oldest.signature)); c.creator = d && d.signers; c.what = classify(d); } catch {}
  }
  R.configs.push(c);
  save('chain.json', R);
  log('config', x.sym, c.createdET || 'not reached', 'pages', pages);
}
log('done');

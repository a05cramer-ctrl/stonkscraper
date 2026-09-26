// Raydium's admin wallet creates LaunchLab quote configs. How busy is it, and how early does a new config
// come before StonkFun lists the quote? Covers every quote, not just the ones the watcher's sweep can see.
import { get, rpc, save, sleep, configPda, et, b58decode, LAUNCHLAB, SF, tx } from './lib.mjs';

const ADMIN = 'RayUzntHM1dWZJyCnkQjHusUGhYyi6gpNf7t8srtty2';
const DISC = { c9cff3724b6f2fbd: 'create_config', '1d9efcbf0a53db63': 'update_config' };
const T0 = Date.now();
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(0) + 's', ...a);
const R = { sigs: 0, perDay: {}, kinds: {}, configs: [], txs: [], errors: [] };

// 1) admin signatures, last 60 days
const sigs = [];
let before, pages = 0;
while (pages < 40) {
  const res = await rpc('getSignaturesForAddress', [ADMIN, { limit: 1000, ...(before ? { before } : {}) }]);
  pages++;
  if (!res || !res.length) break;
  for (const s of res) sigs.push({ sig: s.signature, t: (s.blockTime || 0) * 1000, err: !!s.err });
  before = res[res.length - 1].signature;
  if (res.length < 1000 || res[res.length - 1].blockTime * 1000 < Date.now() - 60 * 864e5) break;
}
R.sigs = sigs.length;
for (const s of sigs) { const d = et(s.t).slice(0, 6); R.perDay[d] = (R.perDay[d] || 0) + 1; }
log('admin sigs', sigs.length, 'pages', pages, 'oldest', sigs.length ? et(sigs[sigs.length - 1].t) : '-');
save('admin.json', R);

// 2) what each tx does; for create_config, which quote mint (the account whose config PDA is also in the ix)
const accountsOf = (ix, keys) => (ix.accounts || []).map((a) => (typeof a === 'number' ? keys[a] : a));
let idx = 0;
const pick = sigs.slice(0, 1500);
async function worker() {
  while (idx < pick.length) {
    const s = pick[idx++];
    let t = null;
    for (let k = 0; k < 3 && !t; k++) { try { t = await tx(s.sig); } catch (e) { if (k === 2) R.errors.push(String(e).slice(0, 100)); await sleep(1500); } }
    if (!t) continue;
    const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const ixs = [...t.transaction.message.instructions, ...((t.meta && t.meta.innerInstructions) || []).flatMap((g) => g.instructions)];
    const kinds = [];
    for (const ix of ixs) {
      const prog = ix.programId || keys[ix.programIdIndex];
      let what = ix.parsed ? `${prog.slice(0, 6)}:${ix.parsed.type}` : null;
      if (!what) {
        let hex = ''; try { hex = b58decode(ix.data || '').subarray(0, 8).toString('hex'); } catch {}
        what = prog === LAUNCHLAB ? (DISC[hex] || 'launchlab:' + hex) : `${prog.slice(0, 6)}:${hex.slice(0, 8)}`;
      }
      kinds.push(what);
      if (prog === LAUNCHLAB && what === 'create_config') {
        const acc = accountsOf(ix, keys);
        let mint = null;
        for (const a of acc) { try { if (acc.includes(configPda(a))) { mint = a; break; } } catch {} }
        R.configs.push({ t: s.t, et: et(s.t), sig: s.sig, mint, acc2: acc[2] || null, config: acc[1] || null, err: s.err });
      }
    }
    for (const k of new Set(kinds)) R.kinds[k] = (R.kinds[k] || 0) + 1;
    R.txs.push({ et: et(s.t), kinds: [...new Set(kinds)].join(',') });
  }
}
await Promise.all([worker(), worker(), worker()]);
R.configs.sort((a, b) => b.t - a.t);
log('classified', R.txs.length, 'configs', R.configs.length, 'kinds', JSON.stringify(R.kinds));
save('admin.json', R);

// 3) match configs to StonkFun quotes: first launch on each (oldest token on the pair)
const pairs = (await get(`${SF}/pairs?_=${Date.now()}`)).json.data.pairs;
const byMint = new Map(pairs.map((p) => [p.mint, p]));
const sun = new Map();
try { for (const x of (await get('https://sunrise.xyz/api/tokens')).json.data.listings) if (x.token && x.token.horizonChainId === 'solana') sun.set(x.token.address, Date.parse(x.listing.visibleFrom)); } catch {}
for (const c of R.configs) {
  const m = c.mint || c.acc2;
  const p = byMint.get(m);
  c.sym = p ? p.symbol : null; c.cat = p ? p.category : null; c.onSF = !!p;
  if (sun.has(m)) { c.sunriseLive = et(sun.get(m)); c.minVsSunrise = Math.round((c.t - sun.get(m)) / 6e4 * 10) / 10; }
  if (p) {
    const r = await get(`${SF}/tokens?quoteMint=${m}&sort=oldest&pageSize=1`, { timeout: 60000 });
    const tk = r.json && r.json.data && r.json.data.tokens && r.json.data.tokens[0];
    if (tk) { c.firstLaunch = et(Date.parse(tk.createdAt)); c.leadMin = Math.round((Date.parse(tk.createdAt) - c.t) / 6e4 * 10) / 10; }
    await sleep(250);
  } else {
    // not a StonkFun quote (yet): what is it?
    try { const j = (await get(`https://lite-api.jup.ag/tokens/v2/search?query=${m}`)).json; const x = Array.isArray(j) && j[0]; if (x) { c.jupSym = x.symbol; c.jupName = x.name; c.jupLiq = Math.round(x.liquidity || 0); } } catch {}
  }
  log(c.et, (c.sym || c.jupSym || '?').padEnd(10), c.onSF ? 'onSF' : 'NOT on SF', 'firstLaunch', c.firstLaunch || '-', 'lead', c.leadMin ?? '-', 'min', c.sunriseLive ? `| sunrise ${c.sunriseLive} (${c.minVsSunrise} min)` : '', c.mint ? '' : 'NO PDA MATCH acc2=' + c.acc2);
}
save('admin.json', R);
log('done');

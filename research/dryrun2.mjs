// Dry run of the fast-lane watcher against real sources (Redis + Discord faked): upgrade pass, quick checks,
// a forced full scan, and the admin-wallet decoder on Raydium's latest admin txs.
import { createRequire } from 'node:module';
import { save, rpc, et } from './lib.mjs';
const require = createRequire(import.meta.url);
process.env.DISCORD_WEBHOOK = 'https://discord.fake/hook';
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://discord.fake')) { sent.push(JSON.parse(opts.body)); return new Response('', { status: 204 }); }
  return realFetch(url, opts);
};
const core = require('./dry/_core.cjs');
const M = global.__REDIS;
const pairs = (await (await realFetch('https://www.stonkfun.xyz/api/public/v1/pairs')).json()).data.pairs;
const bySym = new Map(pairs.map((p) => [p.mint, p.symbol]));
// like production today: v2, feature version 3
M.set('sqw:state', JSON.stringify({ initialized: true, v: 2, fv: 3, pairs: Object.fromEntries(pairs.map((p) => [p.mint, [p.symbol, 1, 1, p.category, 0]])), cfg: {}, deep: {}, stats: { listed: 347, unlisted: 5 } }));
M.set('sqw:events', '[]');
const out = { runs: [] };
async function one(label, prep) {
  M.delete('sqw:lock');
  const run = JSON.parse(M.get('sqw:run') || 'null');
  if (run) { run.t -= 60e3; M.set('sqw:run', JSON.stringify(run)); } // pretend a minute passed (throttle)
  if (prep) { const S = JSON.parse(M.get('sqw:state')); prep(S); M.set('sqw:state', JSON.stringify(S)); }
  const t = Date.now();
  const r = await core.runCheck();
  out.runs.push({ label, r, wallMs: Date.now() - t, pingsSoFar: sent.length });
  console.log(label.padEnd(24), JSON.stringify(r), '| wall', Date.now() - t, 'ms | pings', sent.length);
}
await one('upgrade (full, quiet)');
await one('quick 1');
await one('quick 2');
await one('full (forced)', (S) => { S.fullT = 0; });
await one('quick 3');
// admin wallet: decode its latest txs with the watcher's own decoder
const sigs = await rpc('getSignaturesForAddress', ['RayUzntHM1dWZJyCnkQjHusUGhYyi6gpNf7t8srtty2', { limit: 40 }]);
out.admin = [];
for (const s of sigs) {
  let t = null; try { t = await rpc('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); } catch (e) { out.admin.push({ et: et(s.blockTime * 1000), e: String(e).slice(0, 80) }); continue; }
  const mints = core.configsIn(t);
  out.admin.push({ et: et(s.blockTime * 1000), err: !!s.err, configs: mints.map((m) => ({ m, sf: bySym.get(m) || null })) });
}
console.log('admin decode:'); for (const a of out.admin) console.log(' ', a.et, a.err ? 'ERR' : '', a.e || '', (a.configs || []).map((c) => `${c.sf || '(not on SF)'} ${c.m}`).join(', '));
// and the quick check replaying the last 25 admin txs (configs StonkFun lists are skipped)
await one('quick + admin rewind', (S) => { S.adm = sigs[Math.min(24, sigs.length - 1)].signature; S.fullT = Date.now(); });
const S = JSON.parse(M.get('sqw:state'));
out.pings = sent.map((b) => ({ content: b.content, embeds: b.embeds.map((e) => ({ title: e.title, d: e.description })) }));
console.log('pings:'); for (const p of out.pings) for (const e of p.embeds) console.log(' ', p.content || '(quiet)', '|', e.title, '|', (e.d || '').replace(/\n/g, ' / ').slice(0, 300));
out.watch = S.watch; out.adm = S.adm; out.fv = S.fv; out.fullT = S.fullT; out.stateBytes = M.get('sqw:state').length;
out.top = S.top; out.cfgNew = Object.entries(S.cfg).filter(([, c]) => c.t > 0).map(([m, c]) => ({ m, ...c }));
out.cfgOldCount = Object.values(S.cfg).filter((c) => !(c.t > 0)).length;
console.log('watch:', JSON.stringify(S.watch), 'top:', (S.top || []).length, 'cfg new:', out.cfgNew.length, 'cfg old:', out.cfgOldCount, 'state bytes:', out.stateBytes);
M.delete('sqw:test');
const dg = await core.testPing('digest');
out.digest = sent[sent.length - 1] && sent[sent.length - 1].embeds[0];
console.log('digest:', JSON.stringify(dg), '\n' + (out.digest ? out.digest.title + '\n' + out.digest.description : ''));
save('dryrun2.json', out);

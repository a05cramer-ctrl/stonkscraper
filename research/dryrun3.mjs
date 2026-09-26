// Dry run of the final fast-lane code against real sources (Redis + Discord faked). Replays a real quote
// arrival: CARS is hidden from StonkFun's list, Raydium's admin tx for it is replayed (COMING), then CARS is
// shown again (LIVE with its real coin count).
import { createRequire } from 'node:module';
import { save, rpc, et } from './lib.mjs';
const require = createRequire(import.meta.url);
process.env.DISCORD_WEBHOOK = 'https://discord.fake/hook';
const CARS = 'CARSsxWPkpQWvfyRBwfGMGvysJBHdHGfE46X5MNgmeta';
let hide = true;
const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://discord.fake')) { sent.push(JSON.parse(opts.body)); return new Response('', { status: 204 }); }
  const r = await realFetch(url, opts);
  if (hide && (u.includes('stonkfun.xyz/api/public/v1/pairs') || u.includes('stonkfun.xyz/api/quote-tokens'))) {
    const j = await r.json();
    if (j.data && j.data.pairs) j.data.pairs = j.data.pairs.filter((p) => p.mint !== CARS);
    if (j.quoteTokens) j.quoteTokens = j.quoteTokens.filter((q) => q.quoteMint !== CARS);
    return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return r;
};
const core = require('./dry/_core.cjs');
const M = global.__REDIS;
const pairs = (await (await realFetch('https://www.stonkfun.xyz/api/public/v1/pairs')).json()).data.pairs.filter((p) => p.mint !== CARS);
M.set('sqw:state', JSON.stringify({ initialized: true, v: 2, fv: 3, pairs: Object.fromEntries(pairs.map((p) => [p.mint, [p.symbol, 1, 1, p.category, 0]])), cfg: {}, deep: {}, stats: { listed: 347, unlisted: 5 } }));
M.set('sqw:events', '[]');
const out = { runs: [] };
async function one(label, prep) {
  M.delete('sqw:lock');
  const run = JSON.parse(M.get('sqw:run') || 'null');
  if (run) { run.t -= 60e3; M.set('sqw:run', JSON.stringify(run)); }
  if (prep) { const S = JSON.parse(M.get('sqw:state')); prep(S); M.set('sqw:state', JSON.stringify(S)); }
  const t = Date.now();
  const r = await core.runCheck();
  out.runs.push({ label, r, wallMs: Date.now() - t, pingsSoFar: sent.length });
  console.log(label.padEnd(22), JSON.stringify(r), '| wall', Date.now() - t, 'ms | pings', sent.length);
}
await one('upgrade (full, quiet)');
await one('quick');
const sigs = await rpc('getSignaturesForAddress', ['RayUzntHM1dWZJyCnkQjHusUGhYyi6gpNf7t8srtty2', { limit: 10 }]);
// the admin tx that created CARS's config
let k = -1;
for (let i = 0; i < sigs.length && k < 0; i++) {
  const t = await rpc('getTransaction', [sigs[i].signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (core.configsIn(t).includes(CARS)) k = i;
}
console.log('CARS config tx index', k, k >= 0 ? et(sigs[k].blockTime * 1000) : '');
await one('quick: admin replay', (S) => { S.adm = sigs[k + 1].signature; S.fullT = Date.now(); });
hide = false;
await one('quick: CARS listed', (S) => { S.fullT = Date.now(); });
await one('full (forced)', (S) => { S.fullT = 0; });
out.pings = sent.map((b) => ({ content: b.content, embeds: b.embeds.map((e) => ({ title: e.title, d: e.description })) }));
console.log('\npings:'); for (const p of out.pings) for (const e of p.embeds) console.log('---', p.content || '(quiet)', '\n' + e.title + '\n' + e.d);
const S = JSON.parse(M.get('sqw:state'));
console.log('\nleads', JSON.stringify(S.leads), 'cfg CARS', JSON.stringify(S.cfg[CARS]), 'recent', JSON.stringify(S.recent));
M.delete('sqw:test');
await core.testPing('digest');
const dg = sent[sent.length - 1].embeds[0];
console.log('\ndigest:\n' + dg.title + '\n' + dg.description);
out.digest = dg;
save('dryrun3.json', out);

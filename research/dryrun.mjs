// Dry run of the new watcher code against real sources. Redis and Discord are in-memory fakes.
import { createRequire } from 'node:module';
import { save } from './lib.mjs';
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
// start from a v2 state like production: pairs known, watch running
const pairs = (await (await realFetch('https://www.stonkfun.xyz/api/public/v1/pairs')).json()).data.pairs;
M.set('sqw:state', JSON.stringify({ initialized: true, v: 2, pairs: Object.fromEntries(pairs.map((p) => [p.mint, [p.symbol, 1, 1, p.category, 0]])), cfg: {}, deep: {}, stats: { listed: 347, unlisted: 5 } }));
M.set('sqw:events', '[]');
const out = { runs: [] };
for (let i = 0; i < 3; i++) {
  M.delete('sqw:run'); M.delete('sqw:lock');
  const t = Date.now();
  const r = await core.runCheck();
  out.runs.push({ i, r, wallMs: Date.now() - t, pingsSoFar: sent.length });
  console.log('run', i, JSON.stringify(r), 'wall', Date.now() - t, 'ms', 'pings', sent.length);
}
const S = JSON.parse(M.get('sqw:state'));
const L = JSON.parse(M.get('sqw:likely') || '{"list":[]}').list;
out.pings = sent.map((b) => b.embeds.map((e) => ({ title: e.title, d: e.description })));
out.likely = L.slice(0, 30).map((r) => ({ rank: r.rank, sym: r.sym, liq: r.liq, vol: r.vol, why: r.why }));
out.early = S.early; out.bpCount = Object.keys(S.bp || {}).length; out.top = S.top; out.fv = S.fv; out.dg = S.dg;
out.stateBytes = M.get('sqw:state').length;
console.log('pings:', JSON.stringify(out.pings));
console.log('likely top 30:'); for (const r of out.likely) console.log(' ', r.rank, r.sym, Math.round(r.liq / 1e3) + 'K', Math.round(r.vol / 1e3) + 'K', r.why);
console.log('early recorded (quiet):', Object.entries(S.early).map(([m, e]) => `${e.sym}:${Object.keys(e.st || {}).join('+')}`).join(', '));
console.log('backpack on:', out.bpCount, 'top launches:', (S.top || []).length, 'state bytes:', out.stateBytes);
// also: what the digest would say, and the board state
const g = await core.getState();
out.board = { likely: g.likely.length, early: g.early, run: g.run };
await core.testPing('digest').catch(() => {});
M.delete('sqw:test');
const dg = await core.testPing('digest');
out.digest = sent[sent.length - 1] && sent[sent.length - 1].embeds[0];
console.log('digest:', JSON.stringify(dg), '\n' + (out.digest ? out.digest.title + '\n' + out.digest.description : ''));
save('dryrun.json', out);
// final code 2155

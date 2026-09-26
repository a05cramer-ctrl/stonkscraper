// Shared helpers for the quote-listing research. Node 18+ (global fetch). No deps.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const OUT = process.env.OUT || new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
export const save = (name, data) => fs.writeFileSync(OUT + name, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
export const load = (name) => { try { return JSON.parse(fs.readFileSync(OUT + name, 'utf8')); } catch { return null; } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SF = 'https://www.stonkfun.xyz/api/public/v1';
export const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const PLATFORM = { standard: '4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7', reward: '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt' };
export const LAUNCHER = '5CEbueQnq1Ym2uSSx2xXds3jQAqT1BDnkA59RZobSPAG';
export const KNOWN = {
  ZAMA: { mint: '4Zp52aF4hZi9fzH19xpbWKYKQvgLyCN67KFbrQDqeTKh', config: '9iEYcMmB5X6XF2bLQEx6AZeViLru7gu3KN87wp3HjEB4', createTx: '4pyuMKj3dtDzfLqvZwq5hPmofMVhVsHR7T7223AcgxyeZtnC5ANd89NAzdqKg1hNyyxezvuFqY4A5n1c7qnMNTSA' },
  ENA: { mint: '72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1', config: '5PMxpSLNeQsujXjs5Yoj7XwZWTh9EAdgDj9S9szR1mES' },
  APE: { mint: 'C1MHyoTJpRTeS9AQCyspNVu2EWAYCZwmJ1jNkEArFP1f', config: 'GYDrNGVw2zoqcMuejmBUkFwDzfcn3xPvBDeTprs3BNfF' },
  MASK: { mint: 'HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7' },
  GRASS: { mint: 'Grass7B4RdKfBCjTKgSqnXkqjwiGvQyFbuSCUJr3XXjs' },
  MNDE: { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey' },
  CBLTC: { mint: 'cbLTC4T5NpzSUtQ7ekgEMZGaUPVJY1ko6BUikqa4gGf' },
  SQQQ: { mint: 'SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE' },
  IREN: { mint: 'RENzhrJQgmAnfcLhU1U5XwAMc6TC15UA6jCbPBaasnj' },
};
// Watcher pings (from /api/state, ms epoch)
export const PINGS = {
  ENA: { live: 1790199356099 }, ZAMA: { live: 1790261861746 }, IREN: { live: 1790280140258 },
  GRASS: { coming: 1790301667123, live: 1790301736735 }, SQQQ: { live: 1790347236326 },
  CBLTC: { live: 1790358034913 }, MNDE: { live: 1790359266610 },
  MASK: { coming: 1790397858384, live: 1790398230701 },
};
export const WATCH_START = 1790190153832;

export const et = (ms) => ms ? new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '-';

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', accept: '*/*' };
export async function get(url, { json = true, headers = {}, method = 'GET', body, tries = 3, timeout = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method, body, headers: { ...UA, ...headers }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      const text = await r.text();
      const h = Object.fromEntries(r.headers.entries());
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status} ${url}`); await sleep(1500 * (i + 1)); continue; }
      let j; if (json) { try { j = JSON.parse(text); } catch {} }
      return { status: r.status, headers: h, text, json: j };
    } catch (e) { last = e; await sleep(1000 * (i + 1)); }
  }
  return { status: 0, error: String(last && last.message || last) };
}

export const RPCS = (process.env.RPC_URLS || 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',');
let rpcN = 0;
export async function rpc(method, params, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    const url = RPCS[(rpcN++) % RPCS.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(40000) });
      if (r.status === 429) { last = new Error('429'); await sleep(1200 * (i + 1)); continue; }
      const j = await r.json();
      if (j.error) { last = new Error(JSON.stringify(j.error).slice(0, 200)); await sleep(500 * (i + 1)); continue; }
      return j.result;
    } catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw last;
}

// Oldest signature of an address (pages back with before=). Returns { oldest, count, pages, newest }.
export async function oldestSig(addr, { maxPages = 400, stopBefore = 0 } = {}) {
  let before, count = 0, pages = 0, oldest = null, newest = null;
  for (; pages < maxPages; pages++) {
    const res = await rpc('getSignaturesForAddress', [addr, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!res || !res.length) break;
    if (!newest) newest = res[0];
    count += res.length; oldest = res[res.length - 1]; before = oldest.signature;
    if (res.length < 1000) { pages++; break; }
    if (stopBefore && oldest.blockTime && oldest.blockTime * 1000 < stopBefore) { pages++; break; }
  }
  return { oldest, newest, count, pages, complete: pages < maxPages };
}

export async function tx(sig) {
  return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
}

// Short description of a parsed tx: signers, programs, instruction names / discriminators.
export function describeTx(t) {
  if (!t) return null;
  const msg = t.transaction.message;
  const keys = msg.accountKeys.map((k) => (typeof k === 'string' ? { pubkey: k } : k));
  const signers = keys.filter((k) => k.signer).map((k) => k.pubkey);
  const ixs = [];
  const walk = (ix, inner) => {
    const prog = ix.programId || (keys[ix.programIdIndex] && keys[ix.programIdIndex].pubkey);
    let what = ix.parsed ? (ix.parsed.type || 'parsed') : null;
    if (!what && ix.data) { try { what = 'd:' + b58decode(ix.data).subarray(0, 8).toString('hex'); } catch { what = 'raw'; } }
    ixs.push({ prog, what, inner: !!inner, accounts: (ix.accounts || []).slice(0, 12), info: ix.parsed && ix.parsed.info ? ix.parsed.info : undefined });
  };
  msg.instructions.forEach((ix) => walk(ix, false));
  (t.meta && t.meta.innerInstructions || []).forEach((g) => g.instructions.forEach((ix) => walk(ix, true)));
  return { slot: t.slot, time: t.blockTime * 1000, et: et(t.blockTime * 1000), err: t.meta && t.meta.err, fee: t.meta && t.meta.fee, signers, ixs, logs: (t.meta && t.meta.logMessages || []).filter((l) => /Instruction:|Program log: [A-Za-z]/.test(l)).slice(0, 25) };
}

// ---------- base58 + PDA (same as api/_core.js) ----------
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  let n = 0n;
  for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return Buffer.from(out);
}
export function b58encode(buf) {
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
export function pda(seeds, programId) {
  const prog = b58decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump])); h.update(prog); h.update(Buffer.from('ProgramDerivedAddress'));
    const d = h.digest();
    if (!onCurve(d)) return b58encode(d);
  }
  throw new Error('no PDA');
}
export const configPda = (mint) => pda([Buffer.from('global_config'), b58decode(mint), Buffer.from([0]), Buffer.from([0, 0])], LAUNCHLAB);

// SPL / Token-2022 mint account: authorities at fixed offsets
export function parseMint(b64) {
  const d = Buffer.from(b64, 'base64');
  if (d.length < 82) return null;
  const opt = (o) => (d.readUInt32LE(o) ? b58encode(d.subarray(o + 4, o + 36)) : null);
  return { mintAuthority: opt(0), supply: d.readBigUInt64LE(36).toString(), decimals: d[44], freezeAuthority: opt(46), len: d.length };
}

'use strict';
// Every endpoint needs ?key=WATCH_KEY (set in Vercel env vars) so nobody else sees your upcoming quotes.
// The board (/api/state) also opens with Pulsewatch's read-only key (header x-read-key). Only its sha256 is here;
// the key itself sits in Pulsewatch's private repo. It can't scan, ping or change anything.
const crypto = require('crypto');
const READ_HASH = process.env.READ_KEY_SHA256 || 'c949ef85ba9d9b23a68c1995f21f8400b43d79605140b1d2f23c7c77900a2891';
function readKeyOk(req) {
  const got = req.headers['x-read-key'];
  if (!got || !/^[0-9a-f]{64}$/.test(READ_HASH)) return false;
  const h = crypto.createHash('sha256').update(String(got)).digest();
  const want = Buffer.from(READ_HASH, 'hex');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}
function authed(req, res) {
  const want = process.env.WATCH_KEY;
  if (!want) { send(res, 500, { error: 'Set WATCH_KEY in Vercel -> Settings -> Environment Variables, then redeploy.' }); return false; }
  const u = new URL(req.url, 'http://x');
  const got = u.searchParams.get('key') || req.headers['x-watch-key'];
  if (got !== want) { send(res, 401, { error: 'Wrong or missing key.' }); return false; }
  return true;
}
function wrap(fn, opts = {}) {
  return async (req, res) => {
    if (!(opts.read && readKeyOk(req)) && !authed(req, res)) return;
    try { send(res, 200, await fn(req)); } catch (e) { send(res, 500, { error: e.message }); }
  };
}
module.exports = { wrap };

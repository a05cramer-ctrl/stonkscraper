'use strict';
// Every endpoint needs ?key=WATCH_KEY (set in Vercel env vars) so nobody else sees your upcoming quotes.
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
function wrap(fn) {
  return async (req, res) => {
    if (!authed(req, res)) return;
    try { send(res, 200, await fn(req)); } catch (e) { send(res, 500, { error: e.message }); }
  };
}
module.exports = { wrap };

'use strict';
// Upstash Redis over REST (what Vercel's Storage -> Upstash Redis connects). No dependencies.
function env() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    const k = Object.keys(e).find((k) => /_REST_API_URL$/.test(k) && !/READ_ONLY/.test(k));
    if (k) { url = e[k]; token = e[k.replace(/_URL$/, '_TOKEN')]; }
  }
  if (!url || !token) throw new Error('No Redis connected. Vercel project -> Storage -> Upstash Redis -> Connect, then redeploy.');
  return { url: url.replace(/\/$/, ''), token };
}
async function cmd(...args) {
  const { url, token } = env();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(args.map(String)),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json().catch(() => ({ error: `redis http ${r.status}` }));
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}
module.exports = { cmd };

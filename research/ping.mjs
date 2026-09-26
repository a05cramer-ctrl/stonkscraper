// Is the production watcher scanning? /api/check is the open cron endpoint (no key).
import { get, save } from './lib.mjs';
const out = [];
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const r = await get('https://stonkscraper.vercel.app/api/check?src=research', { timeout: 70000 });
  out.push({ at: new Date(t).toISOString(), status: r.status, body: (r.text || r.error || '').slice(0, 300), ms: Date.now() - t });
  console.log(JSON.stringify(out[out.length - 1]));
  await new Promise((res) => setTimeout(res, 25000));
}
save('check.json', out);

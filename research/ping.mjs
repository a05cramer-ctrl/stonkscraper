// After deploy: poll /api/check until the new code answers (v: 3), then a couple more scans.
import { get, save, sleep } from './lib.mjs';
const out = [];
let seenNew = 0;
for (let i = 0; i < 16 && seenNew < 3; i++) {
  const t = Date.now();
  const r = await get('https://stonkscraper.vercel.app/api/check?src=deploy-check', { timeout: 70000, tries: 1 });
  const row = { at: new Date(t).toISOString(), status: r.status, body: (r.text || r.error || '').slice(0, 300), ms: Date.now() - t };
  out.push(row); console.log(JSON.stringify(row));
  if (/"v":3/.test(row.body)) seenNew++;
  await sleep(25000);
}
save('check.json', out);

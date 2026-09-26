// How fast are the candidate endpoints for StonkFun's top launches?
import { get, save } from './lib.mjs';
const R = {};
for (const [k, u] of Object.entries({
  pubTop: 'https://www.stonkfun.xyz/api/public/v1/tokens?sort=marketCap&pageSize=100',
  pubTop50: 'https://www.stonkfun.xyz/api/public/v1/tokens?sort=marketCap&pageSize=50',
  platPools: 'https://www.stonkfun.xyz/api/platform-pools?pageSize=50&sort=marketCap',
  platPools2: 'https://www.stonkfun.xyz/api/platform-pools?pageSize=100&sort=marketCap',
  sunrise: 'https://sunrise.xyz/api/tokens',
  qt: 'https://www.stonkfun.xyz/api/quote-tokens',
  backpack: 'https://api.backpack.exchange/api/v1/assets',
})) {
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const r = await get(u, { timeout: 60000 });
    (R[k] = R[k] || []).push({ ms: Date.now() - t, status: r.status, len: r.text ? r.text.length : 0, cache: r.headers && (r.headers['x-vercel-cache'] || r.headers['cf-cache-status'] || '') });
    if (i === 0 && k.startsWith('plat')) save(k + '.json', r.json);
  }
  console.log(k, JSON.stringify(R[k]));
}
save('speed.json', R);

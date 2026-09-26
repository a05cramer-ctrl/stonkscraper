// StonkFun's top launches by market cap (Likely next source) + MASK's own record.
import { get, save } from './lib.mjs';
const r = await get('https://www.stonkfun.xyz/api/public/v1/tokens?sort=marketCap&pageSize=100');
save('sf_top.json', r.json);
const r2 = await get('https://www.stonkfun.xyz/api/public/v1/tokens?sort=volume&pageSize=100');
save('sf_topvol.json', r2.json);
const m = await get('https://www.stonkfun.xyz/api/public/v1/tokens/HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7');
save('mask.json', m.json);
const sun = await get('https://sunrise.xyz/api/tokens');
save('sunrise_now.json', sun.json);
const qt = await get('https://www.stonkfun.xyz/api/quote-tokens');
save('qt_now.json', qt.json);
const jv = await get('https://lite-api.jup.ag/tokens/v2/tag?query=verified');
if (Array.isArray(jv.json)) save('jup_now.json', jv.json.map((t) => ({ id: t.id, sym: t.symbol, name: t.name, liq: t.liquidity, mcap: t.mcap, created: t.createdAt, fpool: t.firstPool, tags: t.tags, v24: t.stats24h ? (t.stats24h.buyVolume || 0) + (t.stats24h.sellVolume || 0) : null, lp: t.launchpad, dev: t.dev })));
console.log('top', r.status, 'vol', r2.status, 'mask', m.status, 'sun', sun.status, 'qt', qt.status, 'jup', jv.status);

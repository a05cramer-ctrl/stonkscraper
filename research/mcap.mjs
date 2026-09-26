// When did StonkFun's promoted launches cross $5M market cap, vs when StonkFun made them quotes?
// Hourly candles from GeckoTerminal; market cap = price x supply (from StonkFun's token record).
import { get, save, sleep, et } from './lib.mjs';
const SF = 'https://www.stonkfun.xyz/api/public/v1';
const first = (await get('https://raw.githubusercontent.com/a05cramer-ctrl/stonkscraper/research/research/runs/36270835122-first/first_launch.json')).json;
const top = (await get(`${SF}/tokens?sort=marketCap&pageSize=100`)).json.data.tokens;
const PINGS = { HuAXPyDWDaMYFKuwQHpqL1oPnj93zdzWmtvFGzCeCUa7: 1790398230701 };
// quotes that are StonkFun launches: every top-100 launch that is a pair now
const cases = top.filter((t) => first[t.mint]).map((t) => ({ sym: t.symbol, mint: t.mint, mcapNow: t.market.marketCapUsd, price: t.market.priceUsd, listed: PINGS[t.mint] || (first[t.mint].first ? Date.parse(first[t.mint].first) : null), born: Date.parse(t.createdAt) }));
const out = [];
for (const c of cases) {
  const supply = c.price > 0 ? c.mcapNow / c.price : null;
  const pools = (await get(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${c.mint}/pools?page=1`)).json;
  await sleep(2200);
  const pool = pools && pools.data && pools.data[0];
  if (!pool || !supply) { out.push({ ...c, err: 'no pool/supply' }); continue; }
  const pa = pool.attributes && pool.attributes.address;
  const baseIsToken = pool.relationships && pool.relationships.base_token && pool.relationships.base_token.data.id === `solana_${c.mint}`;
  const o = (await get(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pa}/ohlcv/hour?aggregate=1&limit=1000&currency=usd&token=${baseIsToken ? 'base' : 'quote'}`)).json;
  await sleep(2200);
  const candles = ((o && o.data && o.data.attributes && o.data.attributes.ohlcv_list) || []).map((k) => ({ t: k[0] * 1000, hi: k[2], close: k[4] })).sort((a, b) => a.t - b.t);
  const cross = (x) => { const k = candles.find((k) => k.hi * supply >= x); return k ? k.t : null; };
  const r = { sym: c.sym, mint: c.mint, born: et(c.born), listedET: c.listed ? et(c.listed) : null, mcapNow: Math.round(c.mcapNow), candles: candles.length };
  for (const x of [2e6, 3e6, 5e6, 10e6]) { const t = cross(x); r['cross' + x / 1e6 + 'M'] = t ? et(t) : null; r['lead' + x / 1e6 + 'M_h'] = t && c.listed ? Math.round((c.listed - t) / 36e5 * 10) / 10 : null; }
  out.push(r);
  console.log(JSON.stringify(r));
}
save('mcap.json', out);

// in-memory stand-in for Upstash Redis
const M = global.__REDIS || (global.__REDIS = new Map());
async function cmd(c, ...a) {
  switch (String(c).toUpperCase()) {
    case 'GET': return M.has(a[0]) ? M.get(a[0]) : null;
    case 'MGET': return a.map((k) => (M.has(k) ? M.get(k) : null));
    case 'SET': { if (a.includes('NX') && M.has(a[0])) return null; M.set(a[0], String(a[1])); return 'OK'; }
    case 'DEL': return M.delete(a[0]) ? 1 : 0;
    case 'INCR': { const v = +(M.get(a[0]) || 0) + 1; M.set(a[0], String(v)); return v; }
    default: throw new Error('redis stub: ' + c);
  }
}
module.exports = { cmd };

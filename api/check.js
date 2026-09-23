const { runCheck } = require('./_core');
// Open on purpose so a cron job can hit it without the key. It only starts a scan and
// returns a short status, never the board. Scans are throttled to one per 20s.
module.exports = async (req, res) => {
  let out;
  try {
    const r = await runCheck();
    out = r.skipped ? { skipped: r.skipped } : { ok: r.ok, ms: r.ms, events: r.events };
  } catch (e) { out = { error: e.message }; }
  res.statusCode = out.error ? 500 : 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(out));
};

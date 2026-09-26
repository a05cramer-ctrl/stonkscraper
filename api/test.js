const { wrap } = require('./_http');
const { testPing } = require('./_core');
module.exports = wrap((req) => testPing(new URL(req.url, 'http://x').searchParams.get('what')));

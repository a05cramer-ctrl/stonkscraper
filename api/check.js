const { wrap } = require('./_http');
const { runCheck } = require('./_core');
module.exports = wrap(() => runCheck());

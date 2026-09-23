const { wrap } = require('./_http');
const { testPing } = require('./_core');
module.exports = wrap(() => testPing());

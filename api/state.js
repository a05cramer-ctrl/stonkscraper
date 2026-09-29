const { wrap } = require('./_http');
const { getState } = require('./_core');
module.exports = wrap(() => getState(), { read: true });   // Pulsewatch's read-only key works here

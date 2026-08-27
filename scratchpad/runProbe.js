process.on('exit', () => {
  const log = global.__log || [];
  const last = Math.max(...log.map((r) => r.inst));
  console.error(`\n=== TIDSLINJE för dedupe-adaptern (instans #${last}), endast MNQ ===`);
  for (const r of log) {
    if (r.inst !== last || r.key !== 'MNQ') continue;
    if (r.ev === 'subscribeQuote') console.error(`subscribeQuote  inFlight=${r.inFlight}   <- ${r.stack.split('|')[0].trim()}`);
    else console.error(`  resolveContract cached=${r.cached}`);
  }
});
require('./flakyProbe.js');

'use strict';
const autocannon = require('../node/node_modules/autocannon');
autocannon({
  url: process.argv[2], duration: Number(process.env.BENCH_SECONDS || 5),
  connections: Number(process.env.BENCH_CONNECTIONS || 4), pipelining: 1,
}, (error, result) => {
  if (error) { console.error(error.message); process.exit(1); }
  if (result.errors || result.non2xx) {
    console.error(JSON.stringify({ errors: result.errors, non2xx: result.non2xx }));
    process.exit(1);
  }
  console.log(JSON.stringify({
    p50_ms: result.latency.p50, p99_ms: result.latency.p99,
    requests: result.requests.total, requests_per_second: result.requests.average,
  }));
});

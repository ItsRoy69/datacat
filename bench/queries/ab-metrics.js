// A/B check for the metric query engine: the same queries go to two API builds on the same database
// (A = previous build, B = new build), interleaved, while ingestion runs. Reports per-query median
// latency for each build and whether the returned series are identical (within float tolerance).
// usage: A=http://localhost:8081 B=http://localhost:8082 ROUNDS=5 node ab-metrics.js > ab.json
const fs = require('fs');
const A = process.env.A || 'http://localhost:8081';
const B = process.env.B || 'http://localhost:8082';
const ROUNDS = Number(process.env.ROUNDS || 5);
const env = require('../lib/env');
const pass = env.password();

async function login(base) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: env.email(), password: pass }) });
  const sids = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => c.startsWith('sid=') && c.length > 4);
  return sids[sids.length - 1];
}

const now = Math.floor(Date.now() / 1000);
const H1 = now - 3600, H4 = now - 4 * 3600, D1 = now - 86400, D7 = now - 7 * 86400;
const Q = [
  ['highcard_by_plan_1h', 'sum:scale.orders.placed{*} by {plan}.as_count()', H1],
  ['highcard_total_1h', 'sum:scale.orders.placed{*}.as_count()', H1],
  ['highcard_top_customers_1h', "top(sum:scale.orders.placed{*} by {customer.id}.as_count(), 10, 'sum', 'desc')", H1],
  ['highcard_by_plan_4h', 'sum:scale.orders.placed{*} by {plan}.as_count()', H4],
  ['highcard_avg_by_plan_24h', 'avg:scale.orders.placed{*} by {plan}', D1],
  ['hosts_cpu_7d', 'avg:system.cpu.user{*} by {host}', D7],
  ['hosts_cpu_max_1h', 'max:system.cpu.user{*} by {host}', H1],
  ['trace_metric_7d', 'sum:trace.http.server.request.hits{env:scale} by {service}.as_count()', D7],
  ['trace_rate_1h', 'sum:trace.http.server.request.hits{env:scale}.as_rate()', H1],
];

async function run(base, sid, query, from) {
  const t = performance.now();
  const r = await fetch(`${base}/api/ui/metrics/query`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: sid }, body: JSON.stringify({ queries: [{ name: 'a', query }], from, to: now }) });
  const body = await r.json();
  return { ms: Math.round(performance.now() - t), status: r.status, body };
}

function norm(body) {
  const s = (body.series || []).map((x) => ({ k: x.scope ?? x.key ?? JSON.stringify(x.tags ?? x.tag_set ?? ''), p: (x.pointlist ?? x.points ?? []).map((p) => (Array.isArray(p) ? p : [p.t ?? p[0], p.v ?? p[1]])) }));
  return s.sort((a, b) => (a.k < b.k ? -1 : 1));
}
function same(a, b) {
  const x = norm(a), y = norm(b);
  if (x.length !== y.length) return `series count ${x.length} vs ${y.length}`;
  let maxRel = 0, pts = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i].k !== y[i].k) return `series key ${x[i].k} vs ${y[i].k}`;
    const pb = new Map(y[i].p.map(([t, v]) => [t, v]));
    for (const [t, v] of x[i].p) {
      if (v === null && pb.get(t) === null) continue;
      if (!pb.has(t)) { // the newest bucket can differ because data is still arriving between the two calls
        if (t >= now - 120) continue; return `missing bucket ${t} in ${x[i].k}`;
      }
      const w = pb.get(t); pts++;
      if (t >= now - 120) continue;
      const rel = Math.abs(v - w) / Math.max(1e-9, Math.abs(v), Math.abs(w));
      maxRel = Math.max(maxRel, rel);
    }
  }
  return maxRel < 1e-6 ? true : `max relative diff ${maxRel}`;
}

(async () => {
  const sa = await login(A), sb = await login(B);
  const out = [];
  for (const [name, query, from] of Q) {
    const ta = [], tb = [];
    let cmp = null, statusA, statusB;
    for (let r = 0; r < ROUNDS; r++) {
      // alternate order each round so neither build always gets the warm cache
      const first = r % 2 === 0 ? 'A' : 'B';
      const ra = first === 'A' ? await run(A, sa, query, from) : null;
      const rb = await run(B, sb, query, from);
      const ra2 = ra ?? (await run(A, sa, query, from));
      ta.push(ra2.ms); tb.push(rb.ms); statusA = ra2.status; statusB = rb.status;
      if (r === ROUNDS - 1) cmp = same(ra2.body, rb.body);
    }
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const row = { query: name, a_median_ms: med(ta), b_median_ms: med(tb), speedup: +(med(ta) / Math.max(1, med(tb))).toFixed(1), a_runs_ms: ta, b_runs_ms: tb, status: [statusA, statusB], identical: cmp };
    out.push(row);
    console.error(JSON.stringify(row));
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), A, B, rounds: ROUNDS, results: out }, null, 2));
})();

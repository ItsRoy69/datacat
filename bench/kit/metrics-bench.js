#!/usr/bin/env node
// Metrics product benchmark with known answers, using only the public API:
//   intake  POST /api/v1/series            (DD-API-KEY)
//   query   GET  /api/v1/query?query=...    (DD-API-KEY + DD-APPLICATION-KEY)
// so the same script runs against either storage option.
//
// For each cardinality step it sends C count series and C gauge series (10 points each, one per minute, inside a
// 10-minute window that ends at least 10 minutes in the past), then measures:
//   ingest   requests/s, points/s, request p50/p99, errors
//   visible  seconds until the full total is queryable
//   queries  latency (median of 3) and whether each answer equals the known value
//
//   TARGET=http://localhost:3000 API_KEY=... APP_KEY=... STEPS=1000,10000,50000 node metrics-bench.js > metrics.json
'use strict';
const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.API_KEY, APP_KEY = process.env.APP_KEY;
if (!API_KEY || !APP_KEY) { console.error('set API_KEY and APP_KEY'); process.exit(2); }
const STEPS = (process.env.STEPS || '1000,10000,50000').split(',').map(Number);
const SERIES_PER_REQUEST = Number(process.env.SERIES_PER_REQUEST || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const VISIBLE_TIMEOUT_S = Number(process.env.VISIBLE_TIMEOUT_S || 180);
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 7);
const SHARDS = 10, POINTS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };

// window [T0, T0 + 600): aligned to 600 s so a 600 s rollup gives exactly one bucket
const T0 = Math.floor((Date.now() / 1000 - 1500) / 600) * 600;
const ts = (k) => T0 + 60 * k + 30;
const countVal = (i) => i + 1;                 // unique per series, so top-10 is unambiguous
const gaugeVal = (i, k) => (i * 7 + k * 3) % 50;

async function post(path, body) {
  const t = performance.now();
  try {
    const r = await fetch(TARGET + path, { method: 'POST', headers: { 'content-type': 'application/json', 'DD-API-KEY': API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    await r.arrayBuffer();
    return { ok: r.status < 300, status: r.status, ms: performance.now() - t };
  } catch (e) { return { ok: false, status: 0, ms: performance.now() - t, error: String(e.message || e) }; }
}
async function query(q, from, to) {
  const u = `${TARGET}/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(q)}`;
  const t = performance.now();
  try {
    const r = await fetch(u, { headers: { 'DD-API-KEY': API_KEY, 'DD-APPLICATION-KEY': APP_KEY }, signal: AbortSignal.timeout(120000) });
    const j = await r.json().catch(() => null);
    return { status: r.status, ms: performance.now() - t, body: j };
  } catch (e) { return { status: 0, ms: performance.now() - t, error: String(e.message || e) }; }
}
// one value per series (600 s rollup -> one bucket); key = the group's tag value
function values(body) {
  const out = new Map();
  for (const s of body?.series ?? []) {
    const pts = (s.pointlist ?? []).filter((p) => p[1] !== null);
    const v = pts.reduce((a, p) => a + p[1], 0);
    const tag = (s.tag_set ?? [])[0] ?? s.scope ?? '*';
    out.set(String(tag).split(':').slice(1).join(':') || String(tag), v);
  }
  return out;
}
const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

async function step(C) {
  const mc = `bench.${RUN}.c${C}.count`, mg = `bench.${RUN}.c${C}.gauge`;
  // expected answers
  let total = 0; const byShard = new Map(); const gaugeSum = new Map(), gaugeN = new Map(); let gaugeMax = -Infinity;
  for (let i = 0; i < C; i++) {
    const sh = String(i % SHARDS);
    total += countVal(i) * POINTS;
    byShard.set(sh, (byShard.get(sh) ?? 0) + countVal(i) * POINTS);
    for (let k = 0; k < POINTS; k++) { const g = gaugeVal(i, k); gaugeSum.set(sh, (gaugeSum.get(sh) ?? 0) + g); gaugeN.set(sh, (gaugeN.get(sh) ?? 0) + 1); gaugeMax = Math.max(gaugeMax, g); }
  }
  const top10 = Array.from({ length: Math.min(10, C) }, (_, j) => [`cust-${C - 1 - j}`, countVal(C - 1 - j) * POINTS]);

  // ingest
  const batches = [];
  for (let i0 = 0; i0 < C; i0 += SERIES_PER_REQUEST) {
    const series = [];
    for (let i = i0; i < Math.min(C, i0 + SERIES_PER_REQUEST); i++) {
      const tags = [`shard:${i % SHARDS}`, `cust:cust-${i}`, `run:${RUN}`];
      series.push({ metric: mc, type: 'count', tags, points: Array.from({ length: POINTS }, (_, k) => [ts(k), countVal(i)]) });
      series.push({ metric: mg, type: 'gauge', tags, points: Array.from({ length: POINTS }, (_, k) => [ts(k), gaugeVal(i, k)]) });
    }
    batches.push({ series });
  }
  const lat = []; let errors = 0, next = 0; const errSample = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const r = await post('/api/v1/series', b);
      lat.push(r.ms); if (!r.ok) { errors++; if (errSample.length < 3) errSample.push(r.error ?? r.status); }
    }
  }));
  const secs = (performance.now() - t0) / 1000;
  const points = C * 2 * POINTS;

  // visibility: total of the count metric reaches the expected value
  const from = T0, to = T0 + 600;
  const tv = performance.now(); let visible = null, seen = null;
  while ((performance.now() - tv) / 1000 < VISIBLE_TIMEOUT_S) {
    const r = await query(`sum:${mc}{*}.rollup(sum, 600)`, from, to);
    seen = values(r.body).get('*') ?? [...values(r.body).values()][0] ?? null;
    if (near(seen, total)) { visible = (performance.now() - tv) / 1000; break; }
    await sleep(1000);
  }

  // queries with known answers
  const checks = [
    ['total (sum, all series)', `sum:${mc}{*}.rollup(sum, 600)`, (m) => near(m.get('*') ?? [...m.values()][0], total), `${total}`],
    ['sum by shard (10 groups)', `sum:${mc}{*} by {shard}.rollup(sum, 600)`, (m) => m.size === SHARDS && [...byShard].every(([k, v]) => near(m.get(k), v)), `${SHARDS} groups`],
    ['top 10 customers (high cardinality)', `top(sum:${mc}{*} by {cust}.rollup(sum, 600), 10, 'sum', 'desc')`, (m) => top10.every(([k, v]) => near(m.get(k), v)) && m.size === top10.length, 'cust-' + (C - 1) + '..'],
    ['avg gauge by shard', `avg:${mg}{*} by {shard}.rollup(avg, 600)`, (m) => m.size === SHARDS && [...gaugeSum].every(([k, s]) => near(m.get(k), s / gaugeN.get(k))), 'per-shard mean'],
    ['max gauge, one shard filter', `max:${mg}{shard:3}.rollup(max, 600)`, (m) => near(m.get('*') ?? [...m.values()][0], Math.max(...Array.from({ length: C }, (_, i) => i).filter((i) => i % SHARDS === 3).flatMap((i) => Array.from({ length: POINTS }, (_, k) => gaugeVal(i, k))))), 'max'],
  ];
  const qres = [];
  for (const [name, q, ok, expect] of checks) {
    const ms = []; let last;
    for (let r = 0; r < 3; r++) { last = await query(q, from, to); ms.push(last.ms); }
    const m = values(last.body);
    qres.push({ name, query: q, median_ms: Math.round(pct(ms, 0.5)), status: last.status, correct: last.status === 200 && ok(m), expected: expect });
  }
  return { series: C * 2, points, ingest: { seconds: +secs.toFixed(2), requests: batches.length, points_per_s: Math.round(points / secs), request_p50_ms: Math.round(pct(lat, 0.5)), request_p99_ms: Math.round(pct(lat, 0.99)), errors, error_sample: errSample },
    visible_after_s: visible === null ? null : +visible.toFixed(1), total_seen: seen, total_expected: total, queries: qres };
}

(async () => {
  const out = { target: TARGET, run: RUN, window: [T0, T0 + 600], steps: [] };
  for (const C of STEPS) {
    const r = await step(C);
    out.steps.push({ cardinality: C, ...r });
    process.stderr.write(JSON.stringify({ C, pts_s: r.ingest.points_per_s, p99: r.ingest.request_p99_ms, errors: r.ingest.errors, visible_s: r.visible_after_s, queries: r.queries.map((q) => `${q.median_ms}ms${q.correct ? '' : ' WRONG'}`) }) + '\n');
  }
  out.all_correct = out.steps.every((s) => s.visible_after_s !== null && s.queries.every((q) => q.correct));
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.stack); process.exit(1); });

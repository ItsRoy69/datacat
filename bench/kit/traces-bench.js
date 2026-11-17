#!/usr/bin/env node
// Traces benchmark with known answers.
//   intake  POST /otlp/v1/traces (OTLP/HTTP JSON, header DD-API-KEY) — standard OpenTelemetry, accepted by most backends
//   search  POST /api/v2/spans/events/search (DD-API-KEY + DD-APPLICATION-KEY)
//
// Sends T traces of 5 spans each (gateway -> cart -> catalog, cart -> payments -> db) across 4 services;
// 1 in 25 traces fails in payments. Measures ingest throughput and latency, time until the last trace is
// searchable, and search latency with checks whose answers are known exactly.
//
//   TARGET=http://localhost:3000 API_KEY=... APP_KEY=... TRACES=20000 node traces-bench.js > traces.json
'use strict';
const crypto = require('crypto');
const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/$/, '');
const OTLP = (process.env.OTLP_URL || TARGET + '/otlp/v1/traces');
const API_KEY = process.env.API_KEY, APP_KEY = process.env.APP_KEY;
if (!API_KEY || !APP_KEY) { console.error('set API_KEY and APP_KEY'); process.exit(2); }
const T = Number(process.env.TRACES || 20000);
const PER_REQUEST = Number(process.env.TRACES_PER_REQUEST || 100);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const VISIBLE_TIMEOUT_S = Number(process.env.VISIBLE_TIMEOUT_S || 180);
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const S = (n) => `tb-${RUN}-${n}`;
const fails = (t) => t % 25 === 0;
const tid = (t) => crypto.createHash('sha256').update(`${RUN}:${t}`).digest('hex').slice(0, 32);
const sid = (t, k) => crypto.createHash('sha256').update(`${RUN}:${t}:${k}`).digest('hex').slice(0, 16);

function trace(t, nowNs) {
  const id = tid(t), start = nowNs - BigInt(5e9) + BigInt(t % 1000) * 1000000n;
  const sp = (k, parent, svc, name, offMs, durMs, err) => ({ svc, span: { traceId: id, spanId: sid(t, k), parentSpanId: parent === null ? '' : sid(t, parent), name, kind: k === 0 ? 2 : 3,
    startTimeUnixNano: String(start + BigInt(offMs) * 1000000n), endTimeUnixNano: String(start + BigInt(offMs + durMs) * 1000000n),
    attributes: [{ key: 'bench.run', value: { stringValue: RUN } }, { key: 'order.id', value: { stringValue: `o-${t}` } }, { key: 'bench.trace', value: { stringValue: `${RUN}-t-${t}` } }], status: err ? { code: 2, message: 'card declined' } : { code: 0 } } });
  return [sp(0, null, S('gateway'), 'GET /checkout', 0, 40), sp(1, 0, S('cart'), 'cart.load', 2, 30), sp(2, 1, S('catalog'), 'catalog.price', 4, 8),
    sp(3, 1, S('payments'), 'payments.charge', 14, 15, fails(t)), sp(4, 3, S('payments'), 'db.query', 15, 6)];
}
function payload(spans) {
  const bySvc = new Map();
  for (const { svc, span } of spans) { if (!bySvc.has(svc)) bySvc.set(svc, []); bySvc.get(svc).push(span); }
  return { resourceSpans: [...bySvc].map(([svc, list]) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: svc } }, { key: 'deployment.environment', value: { stringValue: 'bench' } }] },
    scopeSpans: [{ scope: { name: 'traces-bench' }, spans: list }] })) };
}
async function post(url, body, app) {
  const t = performance.now();
  const headers = { 'content-type': 'application/json', 'DD-API-KEY': API_KEY };
  if (app) headers['DD-APPLICATION-KEY'] = APP_KEY;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.status < 300, status: r.status, ms: performance.now() - t, body: json };
  } catch (e) { return { ok: false, status: 0, ms: performance.now() - t, error: String(e.message || e) }; }
}
const search = (query) => post(TARGET + '/api/v2/spans/events/search', { data: { type: 'search_request', attributes: { filter: { query, from: 'now-15m', to: 'now' }, page: { limit: 50 } } } }, true);
const rows = (r) => r.body?.data ?? [];

(async () => {
  const nowNs = BigInt(Date.now()) * 1000000n;
  const batches = [];
  for (let t0 = 0; t0 < T; t0 += PER_REQUEST) {
    const spans = [];
    for (let t = t0; t < Math.min(T, t0 + PER_REQUEST); t++) spans.push(...trace(t, nowNs));
    batches.push(payload(spans));
  }
  const lat = []; let errors = 0, next = 0; const errSample = [];
  const s0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const r = await post(OTLP, batches[next++]);
      lat.push(r.ms); if (!r.ok) { errors++; if (errSample.length < 3) errSample.push(r.error ?? r.status); }
    }
  }));
  const secs = (performance.now() - s0) / 1000;

  const tv = performance.now(); let visible = null;
  while ((performance.now() - tv) / 1000 < VISIBLE_TIMEOUT_S) {
    if (rows(await search(`@bench.trace:${RUN}-t-${T - 1}`)).length === 5) { visible = (performance.now() - tv) / 1000; break; }
    await sleep(500);
  }

  const mid = Math.floor(T / 2), failing = Math.floor(T / 50) * 25; // a failing trace near the middle
  const checks = [
    ['whole trace (5 spans, 4 services, one trace id)', `@bench.trace:${RUN}-t-${mid}`, (d) => d.length === 5 && new Set(d.map((x) => x.attributes.service)).size === 4 && new Set(d.map((x) => String(x.attributes.trace_id))).size === 1],
    ['one service inside a trace', `@bench.trace:${RUN}-t-${mid} service:${S('payments')}`, (d) => d.length === 2],
    ['error span of a failing trace', `@bench.trace:${RUN}-t-${failing} status:error`, (d) => d.length === 1 && d[0].attributes.service === S('payments')],
    ['no error span in a healthy trace', `@bench.trace:${RUN}-t-${failing + 1} status:error`, (d) => d.length === 0],
    ['attribute search (order id)', `service:${S('cart')} @order.id:o-${mid}`, (d) => d.length === 1],
    ['errors in one service (page of 50)', `service:${S('payments')} status:error`, (d) => d.length === Math.min(50, Math.ceil(T / 25)) && d.every((x) => x.attributes.service === S('payments'))],
  ];
  const queries = [];
  for (const [name, q, ok] of checks) {
    const ms = []; let last;
    for (let r = 0; r < 3; r++) { last = await search(q); ms.push(last.ms); }
    queries.push({ name, query: q, median_ms: Math.round(pct(ms, 0.5)), status: last.status, returned: rows(last).length, correct: last.status === 200 && ok(rows(last)) });
  }
  const out = { target: TARGET, run: RUN, traces: T, spans: T * 5, ingest: { seconds: +secs.toFixed(2), requests: batches.length, spans_per_s: Math.round(T * 5 / secs), request_p50_ms: Math.round(pct(lat, 0.5)), request_p99_ms: Math.round(pct(lat, 0.99)), errors, error_sample: errSample },
    last_trace_searchable_after_s: visible === null ? null : +visible.toFixed(1), queries };
  out.all_correct = errors === 0 && visible !== null && queries.every((q) => q.correct);
  process.stderr.write(JSON.stringify({ spans_s: out.ingest.spans_per_s, p99: out.ingest.request_p99_ms, errors, visible_s: out.last_trace_searchable_after_s, queries: queries.map((q) => `${q.median_ms}ms${q.correct ? '' : ` WRONG(${q.returned})`}`) }) + '\n');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.stack); process.exit(1); });

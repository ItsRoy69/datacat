#!/usr/bin/env node
// Logs benchmark with known answers, using only the public API:
//   intake  POST /api/v2/logs                    (DD-API-KEY, JSON array of log objects)
//   search  POST /api/v2/logs/events/search      (DD-API-KEY + DD-APPLICATION-KEY)
// so the same script runs against either storage option.
//
// Sends N logs across 10 services; 1 in 20 is an error; every log carries a unique token in its message.
// Measures ingest throughput and latency, time until the last log is searchable, and search latency with
// checks whose answers are known exactly.
//
//   TARGET=http://localhost:3000 API_KEY=... APP_KEY=... N=50000 node logs-bench.js > logs.json
'use strict';
const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.API_KEY, APP_KEY = process.env.APP_KEY;
if (!API_KEY || !APP_KEY) { console.error('set API_KEY and APP_KEY'); process.exit(2); }
const N = Number(process.env.N || 50000);
const PER_REQUEST = Number(process.env.LOGS_PER_REQUEST || 500);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const VISIBLE_TIMEOUT_S = Number(process.env.VISIBLE_TIMEOUT_S || 180);
const RUN = process.env.RUN || Math.random().toString(36).slice(2, 7);
const SERVICES = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const svc = (i) => `lb-${RUN}-svc${i % SERVICES}`;
const isErr = (i) => Math.floor(i / SERVICES) % 20 === 0; // 1 in 20, spread over every service
const token = (i) => `tok${RUN}x${i}`;

async function post(path, body, app) {
  const t = performance.now();
  const headers = { 'content-type': 'application/json', 'DD-API-KEY': API_KEY };
  if (app) headers['DD-APPLICATION-KEY'] = APP_KEY;
  try {
    const r = await fetch(TARGET + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { ok: r.status < 300, status: r.status, ms: performance.now() - t, body: json };
  } catch (e) { return { ok: false, status: 0, ms: performance.now() - t, error: String(e.message || e) }; }
}
const search = (query, limit = 1000) => post('/api/v2/logs/events/search', { filter: { query, from: 'now-1h', to: 'now' }, page: { limit } }, true);
const count = (r) => (r.body?.data ?? []).length;

(async () => {
  // ingest
  const batches = [];
  for (let i0 = 0; i0 < N; i0 += PER_REQUEST) {
    const b = [];
    for (let i = i0; i < Math.min(N, i0 + PER_REQUEST); i++) {
      b.push({ message: `order ${i} processed ${token(i)}${isErr(i) ? ' payment declined' : ''}`, service: svc(i), hostname: `lb-host-${i % 25}`,
        ddsource: 'bench', ddtags: `env:bench,run:${RUN}`, status: isErr(i) ? 'error' : 'info' });
    }
    batches.push(b);
  }
  const lat = []; let errors = 0, next = 0; const errSample = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < batches.length) {
      const r = await post('/api/v2/logs', batches[next++]);
      lat.push(r.ms); if (!r.ok) { errors++; if (errSample.length < 3) errSample.push(r.error ?? r.status); }
    }
  }));
  const secs = (performance.now() - t0) / 1000;

  // visibility of the very last log
  const tv = performance.now(); let visible = null;
  while ((performance.now() - tv) / 1000 < VISIBLE_TIMEOUT_S) {
    if (count(await search(token(N - 1), 10)) === 1) { visible = (performance.now() - tv) / 1000; break; }
    await sleep(500);
  }

  // known answers (each expected count is <= 1000, the page limit, so returned rows == true count)
  const errsPerSvc = Array.from({ length: N }, (_, i) => i).filter((i) => isErr(i) && i % SERVICES === 3).length;
  const mid = Math.floor(N / 2);
  const checks = [
    ['needle: one unique token', token(mid), 10, 1],
    ['needle: token + service filter', `service:${svc(mid)} ${token(mid)}`, 10, 1],
    ['needle: token, wrong service (must be 0)', `service:${svc(mid + 1)} ${token(mid)}`, 10, 0],
    ['errors for one service', `service:${svc(3)} status:error`, 1000, errsPerSvc],
    ['phrase search in one service', `service:${svc(3)} "payment declined"`, 1000, errsPerSvc],
    ['tag filter + status', `run:${RUN} service:${svc(7)} status:error`, 1000, Array.from({ length: N }, (_, i) => i).filter((i) => isErr(i) && i % SERVICES === 7).length],
  ];
  const queries = [];
  for (const [name, q, limit, expected] of checks) {
    const ms = []; let last;
    for (let r = 0; r < 3; r++) { last = await search(q, limit); ms.push(last.ms); }
    queries.push({ name, query: q, median_ms: Math.round(pct(ms, 0.5)), status: last.status, returned: count(last), expected, correct: last.status === 200 && count(last) === expected });
  }
  const out = { target: TARGET, run: RUN, logs: N, ingest: { seconds: +secs.toFixed(2), requests: batches.length, logs_per_s: Math.round(N / secs), request_p50_ms: Math.round(pct(lat, 0.5)), request_p99_ms: Math.round(pct(lat, 0.99)), errors, error_sample: errSample },
    last_log_searchable_after_s: visible === null ? null : +visible.toFixed(1), queries };
  out.all_correct = errors === 0 && visible !== null && queries.every((q) => q.correct);
  process.stderr.write(JSON.stringify({ logs_s: out.ingest.logs_per_s, p99: out.ingest.request_p99_ms, errors, visible_s: out.last_log_searchable_after_s, queries: queries.map((q) => `${q.median_ms}ms${q.correct ? '' : ` WRONG ${q.returned}/${q.expected}`}`) }) + '\n');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e.stack); process.exit(1); });

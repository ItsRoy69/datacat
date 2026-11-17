/** Evidence-based correlation on ClickHouse storage: the same evidence and output as correlate.ts (see there), queried with ClickHouse SQL. */
import { pool } from "@workspace/db";
import { serviceResources } from "./apmStats";
import { chQuery, ChParams } from "../lib/ch";

const MAX_WINDOW_MS = 60 * 60_000;

// example_pair is [[trace_id, span_id]] taken from one row, so the span always belongs to the linked trace
const numify = (r: any) => ({
  ...r,
  incident: r.incident !== undefined ? Number(r.incident) : undefined,
  baseline: r.baseline !== undefined ? Number(r.baseline) : undefined,
  traces: r.traces !== undefined ? Number(r.traces) : undefined,
  failing_traces: r.failing_traces !== undefined ? Number(r.failing_traces) : undefined,
});
function withExample(r: any) {
  const { example_pair, ...rest } = r;
  const p = example_pair?.[0];
  return { ...rest, example_trace: p?.[0] ?? null, example_span: p?.[1] ?? null };
}

export async function correlateCh(orgId: number, service: string, fromSec: number, toSec: number) {
  let to = toSec * 1000,
    from = fromSec * 1000;
  if (to - from > MAX_WINDOW_MS) from = to - MAX_WINDOW_MS;
  if (to - from < 60_000) from = to - 60_000;
  const span = to - from,
    base0 = from - span;
  const svc = service.toLowerCase();

  const b = new ChParams();
  const O = b.p(orgId, "UInt32"),
    S = b.p(svc),
    B0 = b.p(base0, "Int64"),
    F = b.p(from, "Int64"),
    T = b.p(to, "Int64");
  const VER = "if(meta['version'] != '', meta['version'], meta['service.version'])";
  const MSG =
    "multiIf(meta['error.message'] != '', meta['error.message'], meta['otel.status_description'] != '', meta['otel.status_description'], meta['exception.message'])";
  const STMT = "if(meta['db.statement'] != '', meta['db.statement'], meta['db.query.text'])";
  const q = (sql: string) => chQuery(sql, b.params).then((rows) => ({ rows }));
  const [versions, events, errors, origins, logs, latNow, latBase] = await Promise.all([
    q(`SELECT ${VER} AS version, min(start_ms) AS first_ms, max(start_ms) AS last_ms,
              toUInt32(countIf(start_ms >= ${F})) AS incident, toUInt32(countIf(start_ms < ${F})) AS baseline
         FROM spans WHERE org_id = ${O} AND service = ${S} AND start_ms >= ${B0} AND start_ms < ${T} AND is_top_level = 1
        GROUP BY version ORDER BY first_ms`),
    pool.query(
      `select ts, title, text, tags, source from events
        where org_id=$1 and ts >= $2 and ts < $3 and source <> 'monitor'
          and ($4 = any(tags) or title ilike $5) order by ts`,
      [orgId, base0, to, `service:${svc}`, `%${svc}%`],
    ),
    q(`SELECT resource, ${MSG} AS message, ${STMT} AS statement,
              toUInt32(countIf(start_ms >= ${F})) AS incident, toUInt32(countIf(start_ms < ${F})) AS baseline,
              [argMaxIf([trace_id, span_id], start_ms, start_ms >= ${F})] AS example_pair
         FROM spans WHERE org_id = ${O} AND service = ${S} AND error = 1 AND start_ms >= ${B0} AND start_ms < ${T}
        GROUP BY resource, message, statement ORDER BY (incident - baseline) DESC LIMIT 8`),
    q(`WITH t AS (SELECT DISTINCT trace_id FROM (SELECT trace_id FROM spans WHERE org_id = ${O} AND service = ${S} AND error = 1 AND start_ms >= ${F} AND start_ms < ${T} ORDER BY start_ms DESC LIMIT 500)),
            e AS (SELECT trace_id, span_id, parent_id, service, resource, start_ms, meta FROM spans
                  WHERE org_id = ${O} AND error = 1 AND start_ms >= ${F} - 600000 AND start_ms < ${T} + 600000 AND trace_id IN (SELECT trace_id FROM t))
       SELECT service, resource, ${STMT} AS statement, if(meta['error.message'] != '', meta['error.message'], meta['otel.status_description']) AS message,
              toUInt32(uniqExact(trace_id)) AS traces, [argMax([trace_id, span_id], start_ms)] AS example_pair,
              toUInt32((SELECT count() FROM t)) AS failing_traces
         FROM e WHERE (trace_id, span_id) NOT IN (SELECT trace_id, parent_id FROM e)
        GROUP BY service, resource, statement, message ORDER BY traces DESC LIMIT 5`),
    q(`SELECT replaceRegexpAll(replaceRegexpAll(message, '(?i)[0-9a-f]{12,}', '<id>'), '[0-9]+', '#') AS pattern, max(status) AS max_status,
              toUInt32(countIf(ts >= ${F})) AS incident, toUInt32(countIf(ts < ${F})) AS baseline,
              maxIf(trace_id, ts >= ${F}) AS example_trace
         FROM logs WHERE org_id = ${O} AND service = ${S} AND status IN ('error','warn','warning','critical') AND ts >= ${B0} AND ts < ${T}
        GROUP BY pattern ORDER BY (incident - baseline) DESC LIMIT 6`),
    serviceResources(orgId, svc, Math.floor(from / 1000), Math.floor(to / 1000)),
    serviceResources(orgId, svc, Math.floor(base0 / 1000), Math.floor(from / 1000)),
  ]);

  // version changes: a version first seen inside the compared span (and not only the single steady version)
  const vs = versions.rows.map((r) => ({
    version: r.version,
    first_seen: Number(r.first_ms),
    last_seen: Number(r.last_ms),
    incident_spans: Number(r.incident),
    baseline_spans: Number(r.baseline),
  }));
  const changes: any[] = [];
  if (vs.length > 1) {
    // a version only counts as new if it was not running in the 6 hours before the compared span (a restart on the
    // same version is not a change)
    // Compare with what the service was running right before the compared span: the versions in the last minute of
    // its most recent activity (looking back up to 6 h). A restart on one of those versions is not a change. A version
    // that ran earlier but was not running then (e.g. redeployed after a rollback) is reported as "returned".
    const pb = new ChParams();
    const PO = pb.p(orgId, "UInt32"),
      PS = pb.p(svc),
      P6 = pb.p(base0 - 6 * 3600_000, "Int64"),
      PB = pb.p(base0, "Int64");
    const prevRows = await chQuery(
      `SELECT DISTINCT ${VER} AS version FROM spans WHERE org_id = ${PO} AND service = ${PS} AND is_top_level = 1
        AND start_ms >= (SELECT max(start_ms) FROM spans WHERE org_id = ${PO} AND service = ${PS} AND start_ms >= ${P6} AND start_ms < ${PB} AND is_top_level = 1) - 60000
        AND start_ms <= (SELECT max(start_ms) FROM spans WHERE org_id = ${PO} AND service = ${PS} AND start_ms >= ${P6} AND start_ms < ${PB} AND is_top_level = 1)
        AND start_ms >= ${P6} AND start_ms < ${PB}`,
      pb.params,
    );
    const runningBefore = new Set(prevRows.map((r: any) => r.version as string));
    const lastSeenBefore = async (version: string) => {
      const lb = new ChParams();
      const r = await chQuery(
        `SELECT max(start_ms) AS last, count() AS n FROM spans WHERE org_id = ${lb.p(orgId, "UInt32")} AND service = ${lb.p(svc)}
          AND start_ms >= ${lb.p(base0 - 6 * 3600_000, "Int64")} AND start_ms < ${lb.p(base0, "Int64")} AND is_top_level = 1 AND ${VER} = ${lb.p(version)}`,
        lb.params,
      );
      return Number(r[0]?.n) ? Number(r[0].last) : null;
    };
    for (const v of vs) {
      if (v.first_seen <= base0 + 30_000) continue;
      if (runningBefore.has(v.version)) continue;
      const last = await lastSeenBefore(v.version);
      const name = v.version || "(none)";
      changes.push({
        kind: "version",
        detail: last === null ? `version ${name} first seen` : `version ${name} returned`,
        at: v.first_seen,
        evidence: `${v.baseline_spans} requests on it in the baseline window, ${v.incident_spans} in the incident window${last === null ? "; not seen in the 6 h before" : `; last seen ${new Date(last).toISOString()} before that`}; other versions: ${vs
          .filter((x) => x !== v)
          .map((x) => `${x.version || "(none)"} (${x.baseline_spans} → ${x.incident_spans})`)
          .join(", ")}`,
      });
    }
  }
  for (const e of events.rows)
    changes.push({
      kind: "event",
      detail: e.title,
      at: Number(e.ts),
      evidence: `${e.source} event${e.tags?.length ? ` tagged ${e.tags.join(", ")}` : ""}${e.text ? `: ${String(e.text).slice(0, 200)}` : ""}`,
    });
  changes.sort((a, b) => a.at - b.at);

  const baseMap = new Map(latBase.map((r: any) => [r.resource, r]));
  const latency = latNow
    .map((r: any) => {
      const b: any = baseMap.get(r.resource) ?? { hits: 0, errors: 0, p95: null };
      return { resource: r.resource, incident: { hits: r.hits, errors: r.errors, p95_ns: r.p95 }, baseline: { hits: b.hits, errors: b.errors, p95_ns: b.p95 } };
    })
    .sort(
      (a: any, b: any) =>
        b.incident.errors - b.baseline.errors - (a.incident.errors - a.baseline.errors) ||
        (b.incident.p95_ns ?? 0) - (b.baseline.p95_ns ?? 0) - ((a.incident.p95_ns ?? 0) - (a.baseline.p95_ns ?? 0)),
    )
    .slice(0, 6);

  return {
    service: svc,
    window: { from, to },
    baseline: { from: base0, to: from },
    changes,
    errors: errors.rows
      .map(numify)
      .filter((r: any) => r.incident > r.baseline)
      .map(withExample),
    origins: origins.rows.map(numify).map((r: any) => ({ ...withExample(r), share: r.failing_traces ? r.traces / r.failing_traces : 0 })),
    logs: logs.rows
      .map(numify)
      .map(({ max_status, ...r }: any) => ({ ...r, status: max_status, example_trace: r.example_trace || null }))
      .filter((r: any) => r.incident > r.baseline),
    latency,
    method:
      "Incident window vs the same-length window just before it. Counts are exact over raw spans/logs (failing-trace origins use the 500 most recent failing traces); latency comes from the per-minute APM rollups.",
  };
}

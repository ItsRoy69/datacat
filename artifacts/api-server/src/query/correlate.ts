/**
 * Evidence-based incident correlation for one service.
 *
 * Compares an incident window [from, to) with the baseline window of the same length just before it and reports what
 * measurably changed, each item with its numbers and a link target (trace id). It never states a cause: the UI shows
 * "what changed, by how much, with examples" and leaves the diagnosis to the reader.
 *
 *   changes        versions of the service seen in its spans (first/last seen, span counts per window) and deploy /
 *                  change events posted for it (events API, tag service:<name>, or a title mentioning it)
 *   errors         error spans of the service grouped by operation + error message + DB statement, incident vs baseline
 *   origins        across the service's failing traces in the incident window, the deepest failing span (an error span
 *                  with no failing child): which service / operation / statement it was, in how many traces
 *   logs           error and warning log patterns (numbers and hex ids masked), incident vs baseline, with a trace link
 *   latency        per operation: hits, errors and p95 from the APM rollups, incident vs baseline
 */
import { pool } from "@workspace/db";
import { serviceResources } from "./apmStats";
import { useClickHouse } from "../lib/storage";
import { correlateCh } from "./correlateCh";

const MAX_WINDOW_MS = 60 * 60_000;

// example_pair is [[trace_id, span_id]] taken from one row, so the span always belongs to the linked trace
function withExample(r: any) {
  const { example_pair, ...rest } = r;
  const p = example_pair?.[0];
  return { ...rest, example_trace: p?.[0] ?? null, example_span: p?.[1] ?? null };
}

export async function correlate(orgId: number, service: string, fromSec: number, toSec: number) {
  if (useClickHouse) return correlateCh(orgId, service, fromSec, toSec);
  let to = toSec * 1000,
    from = fromSec * 1000;
  if (to - from > MAX_WINDOW_MS) from = to - MAX_WINDOW_MS;
  if (to - from < 60_000) from = to - 60_000;
  const span = to - from,
    base0 = from - span;
  const svc = service.toLowerCase();

  const [versions, events, errors, origins, logs, latNow, latBase] = await Promise.all([
    pool.query(
      `select coalesce(meta->>'version', meta->>'service.version', '') as version, min(start_ms) as first_ms, max(start_ms) as last_ms,
              count(*) filter (where start_ms >= $4)::int as incident, count(*) filter (where start_ms < $4)::int as baseline
         from spans where org_id=$1 and service=$2 and start_ms >= $3 and start_ms < $5 and is_top_level=1
        group by 1 order by 2`,
      [orgId, svc, base0, from, to],
    ),
    pool.query(
      `select ts, title, text, tags, source from events
        where org_id=$1 and ts >= $2 and ts < $3 and source <> 'monitor'
          and ($4 = any(tags) or title ilike $5) order by ts`,
      [orgId, base0, to, `service:${svc}`, `%${svc}%`],
    ),
    pool.query(
      `select resource, coalesce(meta->>'error.message', meta->>'otel.status_description', meta->>'exception.message', '') as message,
              coalesce(meta->>'db.statement', meta->>'db.query.text', '') as statement,
              count(*) filter (where start_ms >= $4)::int as incident, count(*) filter (where start_ms < $4)::int as baseline,
              (array_agg(array[trace_id::text, span_id::text] order by start_ms desc) filter (where start_ms >= $4))[1:1] as example_pair
         from spans where org_id=$1 and service=$2 and error=1 and start_ms >= $3 and start_ms < $5
        group by 1,2,3 order by (count(*) filter (where start_ms >= $4) - count(*) filter (where start_ms < $4)) desc limit 8`,
      [orgId, svc, base0, from, to],
    ),
    pool.query(
      `with t as (select distinct trace_id from (select trace_id from spans where org_id=$1 and service=$2 and error=1 and start_ms >= $3 and start_ms < $4 order by start_ms desc limit 500) x)
       select e.service, e.resource, coalesce(e.meta->>'db.statement', e.meta->>'db.query.text', '') as statement,
              coalesce(e.meta->>'error.message', e.meta->>'otel.status_description', '') as message,
              count(distinct e.trace_id)::int as traces, (array_agg(array[e.trace_id::text, e.span_id::text] order by e.start_ms desc))[1:1] as example_pair,
              (select count(*) from t)::int as failing_traces
         from spans e join t on t.trace_id = e.trace_id
        where e.org_id=$1 and e.error=1
          and not exists (select 1 from spans c where c.org_id=e.org_id and c.trace_id=e.trace_id and c.parent_id=e.span_id and c.error=1)
        group by 1,2,3,4 order by 5 desc limit 5`,
      [orgId, svc, from, to],
    ),
    pool.query(
      `select regexp_replace(regexp_replace(message, '[0-9a-f]{12,}', '<id>', 'gi'), '[0-9]+', '#', 'g') as pattern, max(status) as status,
              count(*) filter (where ts >= $4)::int as incident, count(*) filter (where ts < $4)::int as baseline,
              max(trace_id) filter (where ts >= $4) as example_trace
         from logs where org_id=$1 and service=$2 and status in ('error','warn','warning','critical') and ts >= $3 and ts < $5
        group by 1 order by (count(*) filter (where ts >= $4) - count(*) filter (where ts < $4)) desc limit 6`,
      [orgId, svc, base0, from, to],
    ),
    serviceResources(orgId, svc, Math.floor(from / 1000), Math.floor(to / 1000)),
    serviceResources(orgId, svc, Math.floor(base0 / 1000), Math.floor(from / 1000)),
  ]);

  // version changes: a version first seen inside the compared span (and not only the single steady version)
  const vs = versions.rows.map((r) => ({
    version: r.version,
    first_seen: Number(r.first_ms),
    last_seen: Number(r.last_ms),
    incident_spans: r.incident,
    baseline_spans: r.baseline,
  }));
  const changes: any[] = [];
  if (vs.length > 1) {
    // a version only counts as new if it was not running in the 6 hours before the compared span (a restart on the
    // same version is not a change)
    // Compare with what the service was running right before the compared span: the versions in the last minute of
    // its most recent activity (looking back up to 6 h). A restart on one of those versions is not a change. A version
    // that ran earlier but was not running then (e.g. redeployed after a rollback) is reported as "returned".
    const prev = await pool.query(
      `with last as (select max(start_ms) as t from spans where org_id=$1 and service=$2 and start_ms >= $3 and start_ms < $4 and is_top_level=1)
       select distinct coalesce(meta->>'version', meta->>'service.version', '') as version from spans, last
        where org_id=$1 and service=$2 and is_top_level=1 and start_ms >= last.t - 60000 and start_ms <= last.t`,
      [orgId, svc, base0 - 6 * 3600_000, base0],
    );
    const runningBefore = new Set(prev.rows.map((r) => r.version as string));
    const lastSeenBefore = async (version: string) => {
      const r = await pool.query(
        `select max(start_ms) as last from spans where org_id=$1 and service=$2 and start_ms >= $3 and start_ms < $4 and is_top_level=1
           and coalesce(meta->>'version', meta->>'service.version', '') = $5`,
        [orgId, svc, base0 - 6 * 3600_000, base0, version],
      );
      return r.rows[0]?.last ? Number(r.rows[0].last) : null;
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
    errors: errors.rows.filter((r) => r.incident > r.baseline).map(withExample),
    origins: origins.rows.map((r) => ({ ...withExample(r), share: r.failing_traces ? r.traces / r.failing_traces : 0 })),
    logs: logs.rows.filter((r) => r.incident > r.baseline),
    latency,
    method:
      "Incident window vs the same-length window just before it. Counts are exact over raw spans/logs (failing-trace origins use the 500 most recent failing traces); latency comes from the per-minute APM rollups.",
  };
}

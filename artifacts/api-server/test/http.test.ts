import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime, pageLimit, encodeCursor, decodeCursor, HttpError } from "../src/lib/http";
import { parseAggregate, limitBuckets, toBuckets } from "../src/query/v2";
import { filterHosts } from "../src/query/hosts";

const NOW = 1_800_000_000;

test("parseTime accepts seconds, milliseconds, ISO and date math", () => {
  assert.equal(parseTime(NOW, 0, NOW), NOW);
  assert.equal(parseTime(String(NOW * 1000), 0, NOW), NOW);
  assert.equal(parseTime(NOW * 1000 + 999, 0, NOW), NOW);
  assert.equal(parseTime("2027-01-15T08:00:00Z", 0, NOW), Date.parse("2027-01-15T08:00:00Z") / 1000);
  assert.equal(parseTime("now", 0, NOW), NOW);
  assert.equal(parseTime("now-15m", 0, NOW), NOW - 900);
  assert.equal(parseTime("now-2h", 0, NOW), NOW - 7200);
  assert.equal(parseTime("now-7d", 0, NOW), NOW - 7 * 86400);
  assert.equal(parseTime(undefined, 42, NOW), 42);
  assert.throws(
    () => parseTime("yesterday-ish", 0, NOW),
    (e: unknown) => e instanceof HttpError && e.status === 400,
  );
});

test("page limits and cursors are validated", () => {
  assert.equal(pageLimit(undefined, 10, 1000), 10);
  assert.equal(pageLimit("5000", 10, 1000), 1000);
  assert.throws(() => pageLimit("0", 10, 1000), HttpError);
  assert.throws(() => pageLimit("abc", 10, 1000), HttpError);
  assert.deepEqual(decodeCursor(encodeCursor([123, "456"])), [123, "456"]);
  assert.equal(decodeCursor(undefined), null);
  assert.throws(() => decodeCursor("not-a-cursor"), HttpError);
});

test("aggregate requests: computes, group_by and limits", () => {
  const a = parseAggregate({
    filter: { from: "now-1h", to: "now", query: "service:web" },
    compute: [{ aggregation: "count" }, { aggregation: "pc99", metric: "@duration" }],
    group_by: [{ facet: "service", limit: 2, sort: { aggregation: "count", order: "desc" } }],
  });
  assert.equal(a.query, "service:web");
  assert.equal(a.computes[1].aggregation, "pc99");
  assert.equal(a.groupBy[0].limit, 2);
  assert.throws(() => parseAggregate({ compute: [{ aggregation: "avg" }] }), /needs a metric/);
  assert.throws(() => parseAggregate({ compute: [{ aggregation: "mode" }] }), /Unsupported/);
  const rows = [
    { g0: "a", c0: 5, c1: 1 },
    { g0: "b", c0: 50, c1: 2 },
    { g0: "c", c0: 20, c1: 3 },
  ];
  const out = limitBuckets(a, toBuckets(a, rows));
  assert.deepEqual(
    out.map((b) => b.by.service),
    ["b", "c"],
  );
  assert.equal(out[0].computes.c0, 50);
});

test("host filter, sort and paging", () => {
  const hosts = [
    { name: "web-1", tags: ["env:prod", "role:web"], cpu: 10 },
    { name: "web-2", tags: ["env:staging", "role:web"], cpu: 80 },
    { name: "db-1", tags: ["env:prod", "role:db"], cpu: 40 },
  ];
  assert.deepEqual(
    filterHosts(hosts, { filter: "web" }).page.map((h) => h.name),
    ["web-1", "web-2"],
  );
  assert.deepEqual(
    filterHosts(hosts, { filter: "env:prod" }).page.map((h) => h.name),
    ["db-1", "web-1"],
  );
  assert.deepEqual(
    filterHosts(hosts, { filter: "host:db-1" }).page.map((h) => h.name),
    ["db-1"],
  );
  assert.deepEqual(
    filterHosts(hosts, { sort_field: "cpu", sort_dir: "desc", count: "2" }).page.map((h) => h.name),
    ["web-2", "db-1"],
  );
  assert.equal(filterHosts(hosts, { filter: "env:prod", count: "1" }).total, 2);
  assert.throws(() => filterHosts(hosts, { sort_field: "bogus" }), HttpError);
});

test("metric queries accept 'by{host}' without spaces and percentile aggregators", async () => {
  const { parseMetricQuery } = await import("../src/query/metrics");
  assert.deepEqual(parseMetricQuery("p95:req.lat{*}by{host}").groupBy, ["host"]);
  assert.equal(parseMetricQuery("p99.9:req.lat{env:prod}").spaceAgg, "p99.9");
  assert.deepEqual(parseMetricQuery("avg:cpu{*} by {host,env}").groupBy, ["host", "env"]);
});

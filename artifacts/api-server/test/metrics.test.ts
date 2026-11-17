import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMetricQuery, parseFilter, matchTags, extractInlineQueries, pickInterval, evalFormula, reduce, type SeriesSet } from "../src/query/metrics";

test("parses aggregator, metric, filter, group-by and functions", () => {
  const q = parseMetricQuery("sum:orders.placed{env:prod,!region:eu} by {plan,host}.as_count().rollup(sum, 60)");
  assert.equal(q.spaceAgg, "sum");
  assert.equal(q.metric, "orders.placed");
  assert.deepEqual(q.groupBy, ["plan", "host"]);
  assert.deepEqual(
    q.fns.map((f) => f.name),
    ["as_count", "rollup"],
  );
  assert.deepEqual(q.fns[1].args, ["sum", "60"]);
  assert.ok(matchTags(q.filter, ["env:prod", "region:us"]));
  assert.ok(!matchTags(q.filter, ["env:prod", "region:eu"]));
  assert.ok(!matchTags(q.filter, ["env:staging", "region:us"]));
});

test("rejects text that is not a metric query", () => {
  assert.throws(() => parseMetricQuery("not a query!"));
});

test("filters support OR, IN, NOT and globs, case-insensitively", () => {
  assert.equal(parseFilter("*"), null);
  assert.ok(matchTags(parseFilter("host:web-*"), ["host:WEB-01"]));
  assert.ok(matchTags(parseFilter("env:prod OR env:staging"), ["env:staging"]));
  assert.ok(matchTags(parseFilter("plan IN (pro, enterprise)"), ["plan:enterprise"]));
  assert.ok(!matchTags(parseFilter("NOT env:prod"), ["env:prod"]));
  assert.ok(matchTags(parseFilter('resource_name:"POST /checkout"'), ["resource_name:post_/checkout"]));
});

test("extracts inline queries from formulas", () => {
  const r = extractInlineQueries("100 * sum:errors{*}.as_count() / sum:hits{*}.as_count()");
  assert.equal(r.formula, "100 * __q0 / __q1");
  assert.deepEqual(Object.values(r.queries), ["sum:errors{*}.as_count()", "sum:hits{*}.as_count()"]);
});

test("picks rollup intervals that keep about 180 points", () => {
  assert.equal(pickInterval(0, 3600), 20);
  assert.equal(pickInterval(0, 86400), 600);
  assert.equal(pickInterval(0, 365 * 86400), 86400);
});

const series = (key: string, tags: string[], pts: [number, number][]): SeriesSet => [{ key, tags, points: new Map(pts) }];

test("formulas combine series point by point", () => {
  const env = {
    a: series(
      "*",
      [],
      [
        [0, 10],
        [60, 20],
      ],
    ),
    b: series(
      "*",
      [],
      [
        [0, 2],
        [60, 4],
      ],
    ),
  };
  const out = evalFormula("a / b * 100", env, 60);
  assert.deepEqual(
    [...out[0].points.entries()],
    [
      [0, 500],
      [60, 500],
    ],
  );
  assert.throws(() => evalFormula("a + missing", env, 60), /Unknown query name/);
});

test("formula functions: abs, cumsum, per_second", () => {
  const env = {
    a: series(
      "*",
      [],
      [
        [0, -6],
        [60, 12],
      ],
    ),
  };
  assert.deepEqual([...evalFormula("abs(a)", env, 60)[0].points.values()], [6, 12]);
  assert.deepEqual([...evalFormula("cumsum(a)", env, 60)[0].points.values()], [-6, 6]);
  assert.deepEqual([...evalFormula("per_second(a)", env, 60)[0].points.values()], [-0.1, 0.2]);
});

test("reducers", () => {
  assert.equal(reduce([1, 2, 3, 4], "sum"), 10);
  assert.equal(reduce([1, 2, 3, 4], "avg"), 2.5);
  assert.equal(reduce([1, 2, 3, 4], "max"), 4);
  assert.equal(reduce([1, 2, 3, 4], "min"), 1);
  assert.ok(Number.isNaN(reduce([], "sum")));
});

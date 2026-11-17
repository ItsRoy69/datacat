import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSearch, SqlBuilder, logResolver, spanResolver } from "../src/query/search";

const logs = (q: string) => {
  const b = new SqlBuilder();
  return { sql: compileSearch(q, logResolver, b, "message"), params: b.params };
};
const spans = (q: string) => {
  const b = new SqlBuilder();
  return { sql: compileSearch(q, spanResolver, b, "resource"), params: b.params };
};

test("empty and wildcard queries match everything", () => {
  assert.equal(logs("").sql, "TRUE");
  assert.equal(logs("*").sql, "TRUE");
});

test("service is compared exactly and lowercased so the index applies", () => {
  const r = logs("service:Checkout");
  assert.equal(r.sql, "service = $1");
  assert.deepEqual(r.params, ["checkout"]);
});

test("free text becomes parameterized ILIKEs, never inline SQL", () => {
  const r = logs(`"x'); drop table logs; --"`);
  assert.equal(r.sql, "message ILIKE $1");
  assert.deepEqual(r.params, ["%x'); drop table logs; --%"]);
  const words = logs("payment declined");
  assert.equal(words.sql, "(message ILIKE $1 AND message ILIKE $2)");
});

test("quoted phrases keep their spaces", () => {
  const r = logs('"payment declined"');
  assert.deepEqual(r.params, ["%payment declined%"]);
});

test("AND, OR, NOT and negation compose with the right precedence", () => {
  const r = logs("service:a OR service:b -status:error");
  assert.equal(r.sql, "(service = $1 OR (service = $2 AND NOT (lower(status) = lower($3))))");
  assert.deepEqual(r.params, ["a", "b", "error"]);
  assert.equal(logs("NOT service:a").sql, "NOT (service = $1)");
});

test("grouped values expand to OR", () => {
  const r = logs("service:(cart OR payments)");
  assert.equal(r.sql, "(service = $1 OR service = $2)");
  assert.deepEqual(r.params, ["cart", "payments"]);
});

test("wildcards use ILIKE and escape LIKE metacharacters", () => {
  const r = logs("host:web-*");
  assert.equal(r.sql, "host ILIKE $1");
  assert.deepEqual(r.params, ["web-%"]);
  assert.deepEqual(logs("host:a_b*").params, ["a\\_b%"]);
});

test("unknown plain keys search tags", () => {
  const r = logs("team:payments");
  assert.match(r.sql, /unnest\(tags\)/);
  assert.deepEqual(r.params, ["team:payments"]);
});

test("exact attribute matches use JSON containment for the GIN index", () => {
  const r = logs("@customer.id:42");
  assert.match(r.sql, /attributes @> \$\d+::jsonb/);
  assert.ok(r.params.includes(JSON.stringify({ "customer.id": 42 })));
  assert.ok(r.params.includes(JSON.stringify({ customer: { id: 42 } })));
});

test("span status maps to the error flag and duration units convert to nanoseconds", () => {
  assert.deepEqual(spans("status:error"), { sql: "error = $1", params: [1] });
  const d = spans("@duration:>250ms");
  assert.equal(d.sql, "duration::double precision > $1");
  assert.deepEqual(d.params, [250_000_000]);
  const range = spans("@duration:[1s TO 2s]");
  assert.deepEqual(range.params, [1e9, 2e9]);
});

test("every bound parameter is referenced in the SQL (Postgres rejects unused parameters)", () => {
  for (const q of ["@plan:gold", "@customer.id:42", "service:shop @plan:gold", "-@plan:gold", "@plan:(gold OR free)", "@plan:gol*", "@plan:*", "@dur:>5"]) {
    for (const r of [logs(q), spans(q)]) {
      for (let i = 1; i <= r.params.length; i++) assert.match(r.sql, new RegExp(`\\$${i}(?!\\d)`), `${q}: $${i} unused in ${r.sql}`);
    }
  }
});

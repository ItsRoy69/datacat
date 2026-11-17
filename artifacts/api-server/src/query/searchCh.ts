// Search syntax -> ClickHouse WHERE fragment (Log Explorer, Trace Explorer, log/APM monitors).
// Same grammar as query/search.ts (the Postgres version); values are always bound as typed parameters.
import { ChParams } from "../lib/ch";

export type ChField = { kind: "col" | "tags" | "num" | "map"; sql: string; numSql?: string; valueMap?: Record<string, number> };
export type ChResolver = (key: string, isAttr: boolean, b: ChParams) => ChField | null;

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push(c);
      i++;
      continue;
    }
    let j = i;
    let q = false;
    let br = 0;
    while (j < s.length) {
      const d = s[j];
      if (d === '"' && s[j - 1] !== "\\") q = !q;
      else if (!q && d === "[") br++;
      else if (!q && d === "]") br--;
      else if (!q && br === 0 && (/\s/.test(d) || d === ")" || (d === "(" && s[j - 1] !== ":"))) break;
      else if (!q && br === 0 && d === "(" && s[j - 1] === ":") {
        let depth = 0;
        for (; j < s.length; j++) {
          if (s[j] === "(") depth++;
          else if (s[j] === ")") {
            depth--;
            if (depth === 0) {
              j++;
              break;
            }
          }
        }
        break;
      }
      j++;
    }
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
const likeFor = (v: string) => (v.includes("*") ? esc(v).replace(/\*/g, "%") : esc(v));
/** A string literal for a Map key or a column name fragment (keys come from the query text). */
export const lit = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function compileSearchCh(query: string, resolve: ChResolver, b: ChParams, textCol: string, textLowerIndexed = false): string {
  const toks = tokenize(query.trim());
  let p = 0;
  const peek = () => toks[p];
  function or(): string {
    const parts = [and()];
    while (peek() === "OR") {
      p++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
  }
  function and(): string {
    const parts: string[] = [];
    while (peek() !== undefined && peek() !== ")" && peek() !== "OR") {
      if (peek() === "AND") {
        p++;
        continue;
      }
      parts.push(unary());
    }
    return parts.length ? (parts.length === 1 ? parts[0] : `(${parts.join(" AND ")})`) : "true";
  }
  function unary(): string {
    let t = toks[p++];
    if (t === "NOT") return `NOT (${unary()})`;
    if (t === "(") {
      const r = or();
      if (peek() === ")") p++;
      return r;
    }
    let neg = false;
    if (t.startsWith("-") && t.length > 1) {
      neg = true;
      t = t.slice(1);
    }
    const r = term(t);
    return neg ? `NOT (${r})` : r;
  }
  function term(t: string): string {
    if (t === "*") return "true";
    const m = /^(@?)([A-Za-z0-9_.\-]+):(.*)$/s.exec(t);
    if (!m || t.startsWith('"')) {
      const v = t.replace(/^"|"$/g, "");
      const pat = "%" + likeFor(v).replace(/^%|%$/g, "") + "%";
      // lower(message) LIKE ... is served by the ngram bloom filter index on lower(message)
      return textLowerIndexed ? `lower(${textCol}) LIKE ${b.p(pat.toLowerCase())}` : `${textCol} ILIKE ${b.p(pat)}`;
    }
    const isAttr = m[1] === "@";
    const key = m[2];
    let val = m[3];
    const f = resolve(key, isAttr, b);
    if (!f) return "false";
    if (val.startsWith("(") && val.endsWith(")")) {
      const inner = val
        .slice(1, -1)
        .split(/\s+OR\s+|\s+/)
        .filter((x) => x && x !== "OR");
      return `(${inner.map((v) => term(`${m[1]}${key}:${v}`)).join(" OR ")})`;
    }
    val = val.replace(/^"|"$/g, "");
    const cmp = /^(>=|<=|>|<)(-?[\d.]+)([a-z]*)$/.exec(val);
    const range = /^\[(-?[\d.]+)([a-z]*)\s+TO\s+(-?[\d.]+)([a-z]*)\]$/i.exec(val);
    if (cmp || range) {
      const num = f.numSql ?? `toFloat64OrNull(${f.sql})`;
      const conv = (n: string, unit: string) => {
        let x = Number(n);
        if (unit) x = x * ({ ns: 1, us: 1e3, ms: 1e6, s: 1e9, m: 6e10 }[unit] ?? 1);
        return x;
      };
      if (cmp) return `${num} ${cmp[1]} ${b.p(conv(cmp[2], cmp[3]), "Float64")}`;
      return `${num} BETWEEN ${b.p(conv(range![1], range![2]), "Float64")} AND ${b.p(conv(range![3], range![4]), "Float64")}`;
    }
    if (f.kind === "tags") return `arrayExists(_t -> _t ILIKE ${b.p(likeFor(key) + ":" + likeFor(val))}, ${f.sql})`;
    if (f.kind === "num") {
      if (val === "*") return `${f.sql} IS NOT NULL`;
      const mapped = f.valueMap?.[val.toLowerCase()];
      return `${f.sql} = ${b.p(mapped ?? Number(val), "Float64")}`;
    }
    if (val === "*") return `${f.sql} != ''`;
    if (val.includes("*")) return `${f.sql} ILIKE ${b.p(likeFor(val))}`;
    if (f.kind === "map") {
      // exact attribute value as typed or lowercased; flattened keys, so "customer.id" also matches {"customer":{"id":..}}
      const vals = [...new Set([val, val.toLowerCase()])];
      return `(${vals.map((v) => `${f.sql} = ${b.p(v)}`).join(" OR ")})`;
    }
    if (f.sql === "service" || f.sql === "env") return `${f.sql} = ${b.p(val.toLowerCase())}`;
    return `lower(${f.sql}) = lower(${b.p(val)})`;
  }
  return or();
}

export const logResolverCh: ChResolver = (key, isAttr, b) => {
  if (!isAttr) {
    if (["service", "host", "source", "status", "trace_id"].includes(key)) return { kind: "col", sql: key };
    return { kind: "tags", sql: "tags" };
  }
  return { kind: "map", sql: `attrs[${b.p(key)}]` };
};

export const spanResolverCh: ChResolver = (key, isAttr, b) => {
  if (!isAttr) {
    if (key === "service" || key === "env" || key === "host") return { kind: "col", sql: key };
    if (key === "resource_name" || key === "resource") return { kind: "col", sql: "resource" };
    if (key === "operation_name" || key === "name") return { kind: "col", sql: "name" };
    if (key === "trace_id") return { kind: "col", sql: "trace_id" };
    if (key === "span_id") return { kind: "col", sql: "span_id" };
    if (key === "status") return { kind: "num", sql: "error", valueMap: { error: 1, ok: 0, info: 0 } };
    if (key === "type") return { kind: "col", sql: "type" };
    return { kind: "col", sql: `meta[${b.p(key)}]` };
  }
  if (key === "duration") return { kind: "num", sql: "duration", numSql: "toFloat64(duration)" };
  const k = b.p(key);
  return {
    kind: "map",
    sql: `if(mapContains(meta, ${k}), meta[${k}], if(mapContains(metrics, ${k}), toString(metrics[${k}]), ''))`,
    numSql: `if(mapContains(metrics, ${k}), metrics[${k}], toFloat64OrNull(meta[${k}]))`,
  };
};

/** Where-clause for logs in [from, to) seconds. */
export function logWhereCh(orgId: number, query: string, from: number, to: number) {
  const b = new ChParams();
  const where = `org_id = ${b.p(orgId, "UInt32")} AND ts >= ${b.p(from * 1000, "Int64")} AND ts < ${b.p(to * 1000, "Int64")} AND ${compileSearchCh(query || "*", logResolverCh, b, "message", true)}`;
  return { where, b };
}
/** Where-clause for spans in [from, to) seconds. */
export function spanWhereCh(orgId: number, query: string, from: number, to: number) {
  const b = new ChParams();
  const where = `org_id = ${b.p(orgId, "UInt32")} AND start_ms >= ${b.p(from * 1000, "Int64")} AND start_ms < ${b.p(to * 1000, "Int64")} AND ${compileSearchCh(query || "*", spanResolverCh, b, "resource")}`;
  return { where, b };
}

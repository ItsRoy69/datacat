import { HttpError } from "../lib/http";

/**
 * GET /api/v1/hosts parameters: `filter` (space-separated terms; a term matches the host name, a tag "key:value",
 * or "host:<name>"), `sort_field` (name, cpu, iowait, load, up, last_reported_time), `sort_dir`, `start`, `count`.
 */
export function filterHosts<
  H extends { name: string; tags?: string[] | null; up?: boolean; last_seen?: number; cpu?: number | null; iowait?: number | null; load15?: number | null },
>(rows: H[], q: Record<string, unknown>): { page: H[]; total: number } {
  const terms = String(q.filter ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const match = (r: H, term: string) => {
    const name = r.name.toLowerCase();
    if (term.startsWith("host:")) return name === term.slice(5);
    if (term.includes(":")) return (r.tags ?? []).some((t) => t.toLowerCase() === term);
    return name.includes(term) || (r.tags ?? []).some((t) => t.toLowerCase() === term);
  };
  let out = rows.filter((r) => terms.every((t) => match(r, t)));
  const field = String(q.sort_field ?? "name");
  const key: Record<string, (r: H) => number | string> = {
    name: (r) => r.name,
    cpu: (r) => r.cpu ?? -1,
    iowait: (r) => r.iowait ?? -1,
    load: (r) => r.load15 ?? -1,
    up: (r) => (r.up ? 1 : 0),
    last_reported_time: (r) => r.last_seen ?? 0,
    apps: (r) => r.name,
  };
  if (!key[field]) throw new HttpError(400, `Invalid sort_field: ${field}`);
  const dir = String(q.sort_dir ?? "asc");
  if (dir !== "asc" && dir !== "desc") throw new HttpError(400, "sort_dir must be asc or desc");
  out = [...out].sort((a, b) => {
    const x = key[field](a),
      y = key[field](b);
    const d = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return dir === "asc" ? d : -d;
  });
  const start = q.start === undefined ? 0 : Number(q.start);
  const count = q.count === undefined ? 100 : Number(q.count);
  if (!Number.isInteger(start) || start < 0) throw new HttpError(400, "start must be a non-negative integer");
  if (!Number.isInteger(count) || count < 1) throw new HttpError(400, "count must be a positive integer");
  return { page: out.slice(start, start + Math.min(count, 1000)), total: out.length };
}

import { AgentPayload } from "./proto";
import { markTopLevel, type SpanIn } from "./store";

/**
 * Trace-agent payloads (POST /api/v0.2/traces). Agents up to 7.6x send spans in `tracerPayloads`; newer agents
 * (7.7x+, e.g. 7.85) send them in `idxTracerPayloads`, where every string is an index into a per-payload string
 * table and tags are typed attributes. Both layouts are read here.
 */
export interface AgentTraces {
  spans: SpanIn[];
  /** trace chunks found in the payload (a chunk with no readable spans still counts) */
  chunks: number;
  hostName: string;
  agentVersion: string;
}

const KIND = ["unspecified", "internal", "server", "client", "producer", "consumer"];

function low64(id: unknown): string {
  if (id === null || id === undefined) return "0";
  if (typeof id === "string" || typeof id === "number" || typeof id === "bigint") return String(id);
  const b = Buffer.from(id as Uint8Array);
  if (!b.length) return "0";
  const tail = b.subarray(Math.max(0, b.length - 8));
  let v = 0n;
  for (const x of tail) v = (v << 8n) | BigInt(x);
  return v.toString();
}

export function decodeAgentPayload(buf: Buffer): any {
  const msg = AgentPayload.decode(buf);
  return AgentPayload.toObject(msg, { longs: String, arrays: true, objects: true, oneofs: true, defaults: false });
}

export function agentPayloadToSpans(p: any): AgentTraces {
  const out: SpanIn[] = [];
  let chunks = 0;
  const hostName = p.hostName ?? "";

  for (const tp of p.tracerPayloads ?? []) {
    for (const chunk of tp.chunks ?? []) {
      chunks++;
      const cs: SpanIn[] = (chunk.spans ?? []).map((s: any) => ({
        traceId: String(s.traceID ?? "0"),
        spanId: String(s.spanID ?? "0"),
        parentId: String(s.parentID ?? "0"),
        service: s.service ?? "",
        name: s.name ?? "",
        resource: s.resource ?? "",
        type: s.type ?? "",
        env: s.meta?.env || tp.env || "",
        host: tp.hostname || hostName,
        start: Number(s.start ?? 0),
        duration: Number(s.duration ?? 0),
        error: s.error ?? 0,
        meta: { ...(s.meta ?? {}), ...(tp.languageName ? { language: tp.languageName } : {}) },
        metrics: s.metrics ?? {},
      }));
      markTopLevel(cs);
      out.push(...cs);
    }
  }

  for (const tp of p.idxTracerPayloads ?? []) {
    const strings: string[] = tp.strings ?? [];
    const str = (ref: unknown) => (ref === undefined || ref === null ? "" : (strings[Number(ref)] ?? ""));
    const lang = str(tp.languageNameRef);
    const tpEnv = str(tp.envRef);
    const tpHost = str(tp.hostnameRef);
    for (const chunk of tp.chunks ?? []) {
      chunks++;
      const traceId = low64(chunk.traceID);
      const cs: SpanIn[] = (chunk.spans ?? []).map((s: any) => {
        const meta: Record<string, string> = {};
        const metrics: Record<string, number> = {};
        for (const [k, v] of Object.entries((s.attributes ?? {}) as Record<string, any>)) addAttr(str(k), v, str, meta, metrics);
        const env = str(s.envRef) || meta.env || tpEnv;
        if (env) meta.env = env;
        const version = str(s.versionRef);
        if (version) meta.version = version;
        const component = str(s.componentRef);
        if (component) meta.component = component;
        if (s.kind) meta["span.kind"] = KIND[s.kind] ?? String(s.kind);
        if (lang && !meta.language) meta.language = lang;
        return {
          traceId,
          spanId: String(s.spanID ?? "0"),
          parentId: String(s.parentID ?? "0"),
          service: str(s.serviceRef),
          name: str(s.nameRef),
          resource: str(s.resourceRef),
          type: str(s.typeRef),
          env,
          host: tpHost || hostName,
          start: Number(s.start ?? 0),
          duration: Number(s.duration ?? 0),
          error: s.error ? 1 : 0,
          meta,
          metrics,
        };
      });
      markTopLevel(cs);
      out.push(...cs);
    }
  }
  return { spans: out, chunks, hostName, agentVersion: p.agentVersion ?? "" };
}

function anyToString(v: any, str: (ref: unknown) => string): string | undefined {
  if (!v) return undefined;
  switch (v.value) {
    case "stringValueRef":
      return str(v.stringValueRef);
    case "boolValue":
      return String(!!v.boolValue);
    case "doubleValue":
      return String(v.doubleValue);
    case "intValue":
      return String(v.intValue);
    case "arrayValue":
      return JSON.stringify((v.arrayValue?.values ?? []).map((x: any) => anyToString(x, str)));
    case "keyValueList":
      return JSON.stringify(Object.fromEntries((v.keyValueList?.keyValues ?? []).map((kv: any) => [str(kv.key), anyToString(kv.value, str)])));
    default:
      return undefined;
  }
}

function addAttr(key: string, v: any, str: (ref: unknown) => string, meta: Record<string, string>, metrics: Record<string, number>) {
  if (!key || !v) return;
  if (v.value === "doubleValue") metrics[key] = Number(v.doubleValue);
  else if (v.value === "intValue") metrics[key] = Number(v.intValue);
  else {
    const s = anyToString(v, str);
    if (s !== undefined) meta[key] = s;
  }
}

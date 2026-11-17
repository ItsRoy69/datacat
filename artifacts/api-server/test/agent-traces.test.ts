import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { decodeAgentPayload, agentPayloadToSpans } from "../src/intake/agentTraces";
import { AgentPayload } from "../src/intake/proto";

// Captured from an unmodified Datadog Agent 7.85.4 (trace-agent -> POST /api/v0.2/traces, zstd + protobuf).
const fixture = zlib.zstdDecompressSync(fs.readFileSync(new URL("./fixtures/agent-7.85.4-traces.pb.zst", import.meta.url)));

test("Agent 7.85 payloads (idxTracerPayloads) decode to spans", () => {
  const t = agentPayloadToSpans(decodeAgentPayload(fixture));
  assert.equal(t.agentVersion, "7.85.4");
  assert.equal(t.hostName, "dd785-host");
  assert.equal(t.chunks, 1);
  assert.equal(t.spans.length, 2);
  const [root, child] = t.spans;
  assert.equal(root.service, "dd785-svc");
  assert.equal(root.name, "web.request");
  assert.equal(root.resource, "GET /dd785");
  assert.equal(root.type, "web");
  assert.equal(root.env, "prod");
  assert.equal(root.traceId, "424242");
  assert.equal(root.spanId, "111");
  assert.equal(root.parentId, "0");
  assert.equal(root.duration, 12_000_000);
  assert.equal(root.error, 0);
  assert.equal(root.meta["http.method"], "GET");
  assert.equal(root.metrics._top_level, 1);
  assert.equal(root.isTopLevel, true);
  assert.equal(child.service, "dd785-db");
  assert.equal(child.parentId, "111");
  assert.equal(child.traceId, "424242");
  assert.equal(child.error, 1);
  assert.equal(child.meta["error.message"], "boom");
  assert.equal(child.isTopLevel, true); // different service from its parent
});

test("Agent 7.5x/7.6x payloads (tracerPayloads) still decode", () => {
  const msg = AgentPayload.fromObject({
    hostName: "old-host",
    agentVersion: "7.56.2",
    tracerPayloads: [
      {
        languageName: "python",
        env: "staging",
        chunks: [
          {
            spans: [
              {
                service: "web",
                name: "flask.request",
                resource: "GET /",
                traceID: "77",
                spanID: "1",
                parentID: "0",
                start: "1000",
                duration: "500",
                error: 0,
                meta: { "http.status_code": "200" },
                metrics: { _top_level: 1 },
                type: "web",
              },
            ],
          },
        ],
      },
    ],
  });
  const t = agentPayloadToSpans(decodeAgentPayload(Buffer.from(AgentPayload.encode(msg).finish())));
  assert.equal(t.spans.length, 1);
  assert.equal(t.spans[0].env, "staging");
  assert.equal(t.spans[0].host, "old-host");
  assert.equal(t.spans[0].meta.language, "python");
  assert.equal(t.spans[0].traceId, "77");
});

test("a payload with chunks but no readable spans is detected, not silently accepted", () => {
  const msg = AgentPayload.fromObject({ hostName: "h", agentVersion: "9.0.0", idxTracerPayloads: [{ strings: [""], chunks: [{ priority: 1 }] }] });
  const t = agentPayloadToSpans(decodeAgentPayload(Buffer.from(AgentPayload.encode(msg).finish())));
  assert.equal(t.spans.length, 0);
  assert.equal(t.chunks, 1);
});

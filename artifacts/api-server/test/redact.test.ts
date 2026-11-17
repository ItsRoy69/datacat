import { test } from "node:test";
import assert from "node:assert/strict";
import { redactString, redactLog, redactSpan } from "../src/intake/redact";

test("masks card numbers that pass the Luhn check, and leaves other numbers", () => {
  assert.equal(redactString("card 4111 1111 1111 1111 ok"), "card [REDACTED:card] ok");
  assert.equal(redactString("order 1234567890123 shipped"), "order 1234567890123 shipped");
});

test("masks bearer tokens, AWS keys, JWTs, secret pairs and private keys", () => {
  assert.equal(redactString("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [REDACTED:bearer]");
  assert.equal(redactString("key AKIAIOSFODNN7EXAMPLE used"), "key [REDACTED:aws_key] used");
  assert.match(redactString("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"), /\[REDACTED:jwt\]/);
  assert.equal(redactString("login password=hunter22 failed"), "login password=[REDACTED:secret] failed");
  assert.equal(redactString("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"), "[REDACTED:private_key]");
});

test("leaves ordinary log lines untouched", () => {
  const line = "GET /api/orders 200 in 35ms";
  assert.equal(redactString(line), line);
});

test("masks secret-named attributes and tags but keeps token counts", () => {
  const l = redactLog({ message: "ok", attributes: { user: { password: "p@ss" }, api_key: "abc", prompt_tokens: "12" }, tags: ["token:xyz", "env:prod"] });
  assert.equal(l.attributes.user.password, "[REDACTED:key]");
  assert.equal(l.attributes.api_key, "[REDACTED:key]");
  assert.equal(l.attributes.prompt_tokens, "12");
  assert.deepEqual(l.tags, ["token:[REDACTED:key]", "env:prod"]);
});

test("masks secrets in span resources and metadata", () => {
  const s = redactSpan({ resource: "GET /pay?token=abcdef123", meta: { authorization: "Basic dXNlcjpwYXNz", "http.url": "/x" } });
  assert.equal(s.resource, "GET /pay?token=[REDACTED:secret]");
  assert.equal(s.meta!.authorization, "[REDACTED:key]");
  assert.equal(s.meta!["http.url"], "/x");
});

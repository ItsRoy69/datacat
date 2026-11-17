import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

// Outbound webhook delivery. By default, destinations on loopback, private, link-local (including cloud metadata
// endpoints) and other non-public addresses are refused, both for IP literals and for every address a hostname
// resolves to at connect time (so DNS rebinding cannot slip through). Redirects are not followed.
// DATACAT_ALLOW_PRIVATE_WEBHOOKS=true allows internal destinations, for receivers on your own network.
const allowPrivate = String(process.env.DATACAT_ALLOW_PRIVATE_WEBHOOKS ?? "false").toLowerCase() === "true";

const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(a, p, "ipv6");

export function isBlockedAddress(ip: string): boolean {
  if (allowPrivate) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  const family = net.isIP(ip);
  if (!family) return true;
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/** Throws when the URL is not an http(s) URL or points at a refused address literal. */
export function checkWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("URL must be a valid http(s) URL"), { status: 400 });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw Object.assign(new Error("URL must start with http(s)://"), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Put credentials in headers, not in the URL"), { status: 400 });
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host))
    throw Object.assign(new Error("Webhook URLs on private or local addresses are disabled (DATACAT_ALLOW_PRIVATE_WEBHOOKS)"), { status: 400 });
  if (!allowPrivate && /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))
    throw Object.assign(new Error("Webhook URLs on private or local addresses are disabled (DATACAT_ALLOW_PRIVATE_WEBHOOKS)"), { status: 400 });
  return u;
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad) return (callback as any)(Object.assign(new Error(`refused: ${hostname} resolves to a private or local address`), { code: "EBLOCKED" }));
    if ((options as any)?.all) return (callback as any)(null, list);
    (callback as any)(null, list[0].address, list[0].family);
  });
};

export function postWebhook(raw: string, headers: Record<string, string>, body: string, timeoutMs = 10_000): Promise<{ status: number }> {
  const u = checkWebhookUrl(raw);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, lookup: safeLookup, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(body);
  });
}

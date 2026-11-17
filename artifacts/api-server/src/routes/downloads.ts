import crypto from "node:crypto";
import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOrigin } from "../lib/config";

/**
 * DataCat Agent and library downloads, plus the one-line agent installer.
 *   GET /downloads/<file>    files from DATACAT_DOWNLOADS_DIR (default: <api-server>/downloads)
 *   GET /install.sh          shell installer; reads DATACAT_API_KEY (and optional DATACAT_ENV, DATACAT_HOSTNAME) from the environment
 */
const router: IRouter = Router();
const DIR = process.env.DATACAT_DOWNLOADS_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../downloads");

router.get("/downloads", (_req, res) => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => !f.startsWith(".")) : [];
  res.json({ files: files.map((f) => ({ name: f, bytes: fs.statSync(path.join(DIR, f)).size, url: `/downloads/${f}` })) });
});

router.get("/downloads/:file", (req, res) => {
  const f = path.basename(String(req.params.file));
  const p = path.join(DIR, f);
  if (!fs.existsSync(p)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.download(p, f);
});

// SHA-256 of the agent binaries this server hosts, computed here (cached by size and mtime) and written into the
// installer, so the installer does not trust a checksum file fetched from the same place as the binary.
const hashCache = new Map<string, { key: string; sha: string }>();
function agentHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(DIR)) return out;
  for (const f of fs.readdirSync(DIR)) {
    if (!/^datacat-agent-(linux|darwin)-(amd64|arm64)$/.test(f)) continue;
    const st = fs.statSync(path.join(DIR, f));
    const key = `${st.size}:${st.mtimeMs}`;
    let c = hashCache.get(f);
    if (!c || c.key !== key) {
      c = {
        key,
        sha: crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(DIR, f)))
          .digest("hex"),
      };
      hashCache.set(f, c);
    }
    out[f] = c.sha;
  }
  return out;
}

router.get("/install.sh", (req, res) => {
  const url = getOrigin(req);
  const quotedUrl = "'" + url.replace(/'/g, "'\\''") + "'";
  const downloadUrl = process.env.DATACAT_DOWNLOAD_URL ?? `${url}/downloads`;
  const quotedDownloads = "'" + downloadUrl.replace(/'/g, "'\\''") + "'";
  const hashes = process.env.DATACAT_DOWNLOAD_URL ? {} : agentHashes();
  const hashLines = Object.entries(hashes)
    .map(([f, h]) => `  ${f}) EXPECTED=${h} ;;`)
    .join("\n");
  res.type("text/x-shellscript").send(`#!/bin/sh
# DataCat Agent installer: curl -fsSL ${url}/install.sh | DATACAT_API_KEY=<key> sh
set -e
URL=\${DATACAT_URL:-${quotedUrl}}
DOWNLOAD_URL=\${DATACAT_DOWNLOAD_URL:-${quotedDownloads}}
[ -n "$DATACAT_API_KEY" ] || { echo "Set DATACAT_API_KEY (Organization Settings -> API Keys)"; exit 1; }
ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) echo "Unsupported architecture: $ARCH"; exit 1;; esac
OS=$(uname -s | tr A-Z a-z)
case "$OS" in linux|darwin) ;; *) echo "Unsupported OS: $OS"; exit 1;; esac
SUDO=""; [ "$(id -u)" = 0 ] || SUDO=sudo
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
FILE="datacat-agent-$OS-$ARCH"
echo "Downloading DataCat Agent ($OS/$ARCH) ..."
# Expected checksum, in order of trust: DATACAT_AGENT_SHA256 (pinned by you), the checksum this server computed for
# the binary it hosts, or SHA256SUMS next to the binary (only when the download source differs from this server).
EXPECTED=\${DATACAT_AGENT_SHA256:-}
if [ -z "$EXPECTED" ]; then
  case "$FILE" in
${hashLines}
  *) ;;
  esac
fi
case "$DOWNLOAD_URL" in
  https://*|"$URL"/*) ;;
  *) [ -n "$EXPECTED" ] || { echo "Refusing to download over plain HTTP from another host without DATACAT_AGENT_SHA256"; exit 1; } ;;
esac
curl -fsSL "$DOWNLOAD_URL/$FILE" -o "$TMP/$FILE"
if [ -z "$EXPECTED" ]; then
  curl -fsSL "$DOWNLOAD_URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
  EXPECTED=$(grep "  $FILE$" "$TMP/SHA256SUMS" | cut -d" " -f1)
fi
[ -n "$EXPECTED" ] || { echo "No checksum available for $FILE"; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$FILE" | cut -d" " -f1)
elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$TMP/$FILE" | cut -d" " -f1)
else echo "Install sha256sum or shasum to verify the download"; exit 1; fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "Checksum mismatch for $FILE: expected $EXPECTED, got $ACTUAL"; exit 1; }
# Releases built by this project's GitHub workflow carry a signed build attestation. With the GitHub CLI installed,
# DATACAT_VERIFY_REPO=<owner>/<repo> checks it before installing.
if [ -n "\${DATACAT_VERIFY_REPO:-}" ]; then
  command -v gh >/dev/null 2>&1 || { echo "DATACAT_VERIFY_REPO is set but the GitHub CLI (gh) is not installed"; exit 1; }
  gh attestation verify "$TMP/$FILE" --repo "$DATACAT_VERIFY_REPO" >/dev/null || { echo "Attestation check failed for $FILE"; exit 1; }
  echo "Verified build attestation from $DATACAT_VERIFY_REPO."
fi
$SUDO mkdir -p /opt/datacat-agent/bin /etc/datacat
$SUDO install -m 0755 "$TMP/$FILE" /opt/datacat-agent/bin/datacat-agent
curl -fsSL "$DOWNLOAD_URL/datacat-agent-THIRD_PARTY_NOTICES.txt" -o "$TMP/NOTICES" 2>/dev/null && $SUDO install -m 0644 "$TMP/NOTICES" /opt/datacat-agent/THIRD_PARTY_NOTICES.txt || true
if [ ! -f /etc/datacat/datacat.yaml ]; then
  $SUDO touch /etc/datacat/datacat.yaml
  $SUDO chmod 0600 /etc/datacat/datacat.yaml
  $SUDO tee /etc/datacat/datacat.yaml >/dev/null <<CFG
api_key: $DATACAT_API_KEY
url: $URL
\${DATACAT_HOSTNAME:+hostname: $DATACAT_HOSTNAME}
env: \${DATACAT_ENV:-prod}
tags: []
host_metrics:
  enabled: true
  interval: 15s
apm:
  otlp: true
  datadog_compat: true
dogstatsd:
  enabled: true
  port: 8125
logs: []
CFG
fi
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  $SUDO tee /etc/systemd/system/datacat-agent.service >/dev/null <<UNIT
[Unit]
Description=DataCat Agent
After=network-online.target
[Service]
ExecStart=/opt/datacat-agent/bin/datacat-agent run -c /etc/datacat/datacat.yaml
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload && $SUDO systemctl enable --now datacat-agent
  echo "DataCat Agent installed and running (systemctl status datacat-agent)."
else
  echo "Installed. Start it with: /opt/datacat-agent/bin/datacat-agent run -c /etc/datacat/datacat.yaml"
fi
`);
});

export default router;

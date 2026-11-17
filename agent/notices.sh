#!/usr/bin/env bash
# Writes the license and notice texts of every Go module compiled into the agent, for all release targets.
# Run from the generated module directory (agent/_build). Usage: bash ../notices.sh <output file>
set -euo pipefail
OUT="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGETS="${TARGETS:-linux/amd64 linux/arm64 darwin/arm64 darwin/amd64}"
{
  cat "$HERE/THIRD_PARTY_NOTICES.header"
  for target in $TARGETS; do
    GOOS="${target%/*}" GOARCH="${target#*/}" CGO_ENABLED=0 go list -deps -tags grpcnotrace \
      -f '{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}|{{.Dir}}{{end}}{{end}}' .
  done | sort -u | while IFS='|' read -r mod dir; do
    files=$(find "$dir" -maxdepth 1 -type f \( -iname 'LICEN[CS]E*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) | sort)
    if [ -z "$files" ]; then
      echo "warning: no license file found for $mod" >&2
      continue
    fi
    printf '\n%s\n%s\n' "================================================================================" "$mod"
    for f in $files; do
      printf '\n--- %s\n\n' "$(basename "$f")"
      cat "$f"
    done
  done
} > "$OUT"

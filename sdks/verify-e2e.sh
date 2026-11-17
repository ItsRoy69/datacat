#!/usr/bin/env bash
# Run from a checkout with both SDK dependencies installed. Never prints the key.
set -euo pipefail
cd "$(dirname "$0")"
export DATACAT_URL="${DATACAT_URL:-http://localhost:3000}"
: "${DATACAT_API_KEY:?Set DATACAT_API_KEY}"
export DATACAT_API_KEY
export DATACAT_VERIFY_REMOTE=true
node node/test/verify.js
python/.venv/bin/python python/tests/verify.py
psql "${DATABASE_URL:-postgresql://datacat:datacat@localhost/datacat}" -v ON_ERROR_STOP=1 <<'SQL'
SELECT service, count(*) AS spans FROM spans
WHERE service IN ('datacat-node-verify','datacat-python-verify') GROUP BY service;
SELECT service, count(*) AS correlated_logs FROM logs
WHERE service IN ('datacat-node-verify','datacat-python-verify')
AND trace_id IS NOT NULL AND trace_id <> '' GROUP BY service;
SELECT metric, count(*) AS series FROM metric_series
WHERE metric IN ('datacat.example.node.requests','datacat.example.python.requests') GROUP BY metric;
DO $$
DECLARE service_name text;
BEGIN
  FOREACH service_name IN ARRAY ARRAY['datacat-node-verify','datacat-python-verify'] LOOP
    IF NOT EXISTS (SELECT 1 FROM spans WHERE service = service_name) THEN
      RAISE EXCEPTION 'Missing spans for %', service_name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM logs l JOIN spans s ON l.trace_id = s.trace_id
                   WHERE l.service = service_name AND s.service = service_name) THEN
      RAISE EXCEPTION 'Missing correlated logs for %', service_name;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT metric) FROM metric_series WHERE metric IN
      ('datacat.example.node.requests','datacat.example.python.requests')) <> 2 THEN
    RAISE EXCEPTION 'Missing SDK custom metrics';
  END IF;
END $$;
SQL

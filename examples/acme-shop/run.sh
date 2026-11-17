#!/bin/bash
# Acme Shop on the DataCat stack: five services instrumented with the DataCat libraries, sending to DataCat directly
# (DATACAT_URL + DATACAT_API_KEY) or to a local DataCat Agent (leave DATACAT_URL unset). See README.md for setup.
set -e
cd "$(dirname "$0")"
export ACME_DATABASE_URL=${ACME_DATABASE_URL:-postgresql://localhost/shop}
export ACME_LOG_DIR=${ACME_LOG_DIR:-/tmp/acme-shop}
mkdir -p "$ACME_LOG_DIR"
PY=${ACME_PYTHON:-.venv/bin}
export DATACAT_ENV=${DATACAT_ENV:-prod} DATACAT_TAGS=${DATACAT_TAGS:-team:acme}
psql "$ACME_DATABASE_URL" -q -c "create table if not exists carts (id bigserial primary key, user_id int not null, sku text not null, qty int not null);
  create table if not exists orders (id bigserial primary key, user_id int not null, total_cents int not null, status text not null);"
trap 'kill 0' EXIT
DATACAT_SERVICE=web-gateway DATACAT_VERSION=2.5.0 node -r @datacat/trace/init gateway/app.js &
# cart-service runs under a restart loop that reads its version from /tmp/acme-cart-version (what a deploy system does);
# bench/incident/inject.sh deploy-bad|rollback "deploys" a new version by writing the file and restarting the process.
(while true; do DATACAT_SERVICE=cart-service DATACAT_VERSION=$(cat /tmp/acme-cart-version 2>/dev/null || echo 2.0.0) node -r @datacat/trace/init cart/app.js; sleep 0.5; done) &
DATACAT_SERVICE=payments-service DATACAT_VERSION=3.2.0 node -r @datacat/trace/init payments/app.js &
DATACAT_SERVICE=catalog-service DATACAT_VERSION=1.3.0 $PY/datacat-run $PY/python catalog/app.py &
sleep 5
DATACAT_SERVICE=order-worker DATACAT_VERSION=0.9.0 $PY/datacat-run $PY/python worker/worker.py &
node traffic.js &
wait

# datacat-trace

DataCat tracing, metrics and correlated logs built on OpenTelemetry. Python 3.10+; use a virtual environment (Python 3.14 is supported by current OTel releases).

## Install and start

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install 'datacat-trace[instrumentation]'
DATACAT_SERVICE=checkout datacat-run python app.py
```

For this checkout:

```sh
cd sdks/python
.venv/bin/pip install -e '.[instrumentation,test]'
DATACAT_SERVICE=python-example .venv/bin/datacat-run python examples/app.py
```

`datacat-run` selects the DataCat distro and configurator entry points and invokes `opentelemetry-instrument`. The `instrumentation` extra (or `datacat-bootstrap` after installing the package) installs Flask, Django, FastAPI, requests, urllib3, sqlite3, psycopg2, psycopg, Redis and logging instrumentors. Install the frameworks and database drivers your application actually uses separately.

Programmatic initialization must happen **before** importing your frameworks/drivers:

```python
import datacat
datacat.init(service="checkout", env="production", version="1.2.3")
from datacat import tracer, metrics
with tracer.trace("checkout.calculate", resource="cart", tags={"region": "us"}) as span:
    span.set_attribute("cart.items", 2)
    metrics.increment("checkout.requests", tags=["region:us"])
```

Spans are native OTel spans; exceptions are automatically recorded and spans are always closed. Supported HTTP clients and servers use W3C propagation. Stdlib logging records get `trace_id`, `span_id`, `otelTraceID`, `otelSpanID`, `otelTraceSampled` and `otelServiceName`. Enabled log records are shipped over OTLP, without file tailing. Set `logging.getLogger().setLevel(logging.INFO)` to include INFO logs. A root OTLP handler is installed at initialization; avoid `basicConfig(force=True)`, which removes handlers.

## Destination and configuration

Agent default: `http://localhost:4318`. For agentless export:

```sh
DATACAT_URL=https://your-datacat.example DATACAT_API_KEY="$YOUR_KEY" \
DATACAT_SERVICE=checkout datacat-run python app.py
```

The URL is the application origin **without** `/otlp`; exporters append `/otlp/v1/{traces,metrics,logs}` and authenticate using `DC-API-KEY`.

| Variable | Meaning / default |
| --- | --- |
| `DATACAT_SERVICE` | Service name; `OTEL_SERVICE_NAME`, resource attributes, then `DD_SERVICE`; default `python-app` |
| `DATACAT_ENV` | Environment; OTel resource attribute, then `DD_ENV` |
| `DATACAT_VERSION` | Service version; OTel resource attribute, then `DD_VERSION` |
| `DATACAT_TAGS` | Comma-separated `key:value` resource tags; fallback `DD_TAGS` |
| `DATACAT_URL` / `DATACAT_API_KEY` | Agentless origin and key; missing key is an error |
| `DATACAT_AGENT_URL` | OTLP HTTP agent base; fallback `OTEL_EXPORTER_OTLP_ENDPOINT`, then localhost:4318 |
| `DATACAT_LOGS_INJECTION` | Record correlation fields; default `true`; shipping remains enabled |
| `DATACAT_LOG_SHIPPING` | Ship log records over OTLP from the app; default `true`; set `false` when the DataCat Agent tails log files (IDs are still injected) |
| `DATACAT_HANDLE_SIGNALS` | Flush on SIGTERM when the app has no SIGTERM handler of its own; default `true` |
| `DATACAT_EXPORT_RETRY_SECONDS` | How long a span batch is retried while the agent/endpoint is unreachable or returns 408/429/502/503/504; default `30` |
| `DATACAT_EXPORT_YIELD_EVERY` | While encoding a batch, release the GIL every N spans so requests are not stalled behind the export thread; default `32`, `0` disables |
| `DATACAT_TRACE_DB_COMMIT` | Trace `connection.commit()` as a `<db>.connection.commit` span; default `false` |
| `DATACAT_FAST_FLASK` | Lean Flask server spans (method, route, path, status, W3C context) instead of OpenTelemetry's generic Flask instrumentation; default `true` |
| `DATACAT_HTTP_METRICS` | Also record OpenTelemetry's per-request duration metrics in the app; default `false`, because DataCat derives request counts, errors and latency from spans at ingest |
| `DATACAT_SAMPLE_RATE` | Parent-based root probability `[0,1]`; fallback `OTEL_TRACES_SAMPLER_ARG`, default `1` |
| `DATACAT_RUNTIME_METRICS` | Optional GC object count; default `false` |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional `key=value` resource attributes |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Full signal URL when no explicit DataCat destination |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated URL-encoded `key=value` headers |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metrics interval in milliseconds; default `10000` |
| `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS` | Comma-separated instrumentor names to disable |

`init()` accepts `service`, `env`, `version`, `tags`, `url`, `api_key`, `agent_url`, `logs_injection`, `sample_rate`, `runtime_metrics`, `metric_interval`. DataCat configuration wins over OTel and migration values. All resources include `telemetry.distro.name=datacat` and `telemetry.distro.version`. All exporters use OTLP/HTTP protobuf, with DELTA counters and histograms.

## Custom metrics and lifecycle

```python
from datacat import metrics
metrics.increment("orders.total")                    # defaults to 1
metrics.gauge("queue.depth", 12, tags={"queue": "work"})
metrics.histogram("orders.duration", 42, tags=["unit:ms"])
metrics.distribution("orders.size", 100)              # OTel histogram
datacat.force_flush()
datacat.shutdown()
```

Natural interpreter exit drains providers. Explicitly shut down on graceful termination. Initialize once, and do not install a second OTel provider. With prefork servers initialize in each worker after forking; provider reinitialization in the same process is not supported.

## Verification

`.venv/bin/python -m unittest discover -s tests` tests configuration. `.venv/bin/python tests/verify.py` runs all signals through a temporary local protobuf sink. To send to DataCat instead:
`DATACAT_VERIFY_REMOTE=true DATACAT_URL=http://localhost:3000 DATACAT_API_KEY=... .venv/bin/python tests/verify.py`.
The verification service is `datacat-python-verify`; confirm its rows in the database or UI.

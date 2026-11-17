"""DataCat configuration and migration environment fallbacks."""
import os
from urllib.parse import unquote


def tags(value):
    if not value:
        return {}
    if isinstance(value, dict):
        return dict(value)
    result = {}
    for item in value.split(",") if isinstance(value, str) else value:
        key, sep, val = item.partition(":")
        if key:
            result[key] = val if sep else True
    return result


def configuration(options=None, environ=None):
    options = options or {}
    env = dict(os.environ if environ is None else environ)

    def first(*values):
        return next((v for v in values if v is not None and v != ""), None)

    def boolean(value, default):
        return default if value is None else str(value).lower() != "false"

    url = first(options.get("url"), env.get("DATACAT_URL"))
    key = first(options.get("api_key"), env.get("DATACAT_API_KEY"))
    if url and not key:
        raise ValueError("DATACAT_URL requires DATACAT_API_KEY")
    explicit_agent = first(options.get("agent_url"), env.get("DATACAT_AGENT_URL"))
    base = (url.rstrip("/") + "/otlp" if url else first(
        explicit_agent, env.get("OTEL_EXPORTER_OTLP_ENDPOINT"), "http://localhost:4318"
    )).rstrip("/")
    headers = {}
    for item in env.get("OTEL_EXPORTER_OTLP_HEADERS", "").split(","):
        if item:
            name, sep, value = item.partition("=")
            if not sep:
                raise ValueError("Invalid OTEL_EXPORTER_OTLP_HEADERS")
            headers[name.strip()] = unquote(value.strip())
    if url:
        headers["DC-API-KEY"] = key
    attributes = {}
    for item in env.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        name, sep, value = item.partition("=")
        if sep:
            attributes[name] = unquote(value)
    attributes.update(tags(first(options.get("tags"), env.get("DATACAT_TAGS"), env.get("DD_TAGS"))))
    attributes["service.name"] = first(
        options.get("service"), env.get("DATACAT_SERVICE"), env.get("OTEL_SERVICE_NAME"),
        attributes.get("service.name"), env.get("DD_SERVICE"), "python-app",
    )
    version = first(options.get("version"), env.get("DATACAT_VERSION"),
                    attributes.get("service.version"), env.get("DD_VERSION"))
    environment = first(options.get("env"), env.get("DATACAT_ENV"),
                        attributes.get("deployment.environment"),
                        attributes.get("deployment.environment.name"), env.get("DD_ENV"))
    if version:
        attributes["service.version"] = version
    if environment:
        attributes["deployment.environment"] = environment
    attributes["telemetry.distro.name"] = "datacat"
    attributes["telemetry.distro.version"] = "0.1.0"
    sample_rate = float(first(options.get("sample_rate"), env.get("DATACAT_SAMPLE_RATE"),
                              env.get("OTEL_TRACES_SAMPLER_ARG"), 1))
    if not 0 <= sample_rate <= 1:
        raise ValueError("DATACAT_SAMPLE_RATE must be between 0 and 1")
    return {
        "attributes": attributes,
        "headers": headers,
        "endpoints": {signal: (
            env.get(f"OTEL_EXPORTER_OTLP_{signal.upper()}_ENDPOINT")
            if not url and not explicit_agent else None
        ) or f"{base}/v1/{signal}" for signal in ("traces", "metrics", "logs")},
        "sample_rate": sample_rate,
        "sample_rate_override": first(options.get("sample_rate"), env.get("DATACAT_SAMPLE_RATE")) is not None,
        "logs_injection": boolean(first(options.get("logs_injection"), env.get("DATACAT_LOGS_INJECTION")), True),
        "trace_db_commit": boolean(first(options.get("trace_db_commit"), env.get("DATACAT_TRACE_DB_COMMIT")), False),
        "fast_flask": boolean(first(options.get("fast_flask"), env.get("DATACAT_FAST_FLASK")), True),
        "http_metrics": boolean(first(options.get("http_metrics"), env.get("DATACAT_HTTP_METRICS")), False),
        # Ship log records over OTLP from the app; turn off when the DataCat Agent tails the app's log files.
        "log_shipping": boolean(first(options.get("log_shipping"), env.get("DATACAT_LOG_SHIPPING")), True),
        # Flush on SIGTERM (Python's default SIGTERM exit skips atexit, losing the last batch and metric interval).
        "handle_signals": boolean(first(options.get("handle_signals"), env.get("DATACAT_HANDLE_SIGNALS")), True),
        "runtime_metrics": boolean(first(options.get("runtime_metrics"), env.get("DATACAT_RUNTIME_METRICS")), False),
        "metric_interval": float(first(options.get("metric_interval"), env.get("OTEL_METRIC_EXPORT_INTERVAL"), 10000)),
    }

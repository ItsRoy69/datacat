"""Lean Flask server tracing (default; DATACAT_FAST_FLASK=false restores OpenTelemetry's Flask instrumentation).

OpenTelemetry's Flask instrumentation is generic: it runs the global propagators (trace context and baggage), collects
a large set of semantic-convention request attributes, records request duration and active-request metrics, and
wraps several Flask hooks. In profiles of a small Flask service it was the biggest single source of tracing CPU.

DataCat's backend needs one server span per request with the method, route, path and status (it derives request
counts, errors and latency metrics from spans at ingest). This module creates exactly that with the OpenTelemetry
SDK, continuing W3C ``traceparent`` context from the caller, so child spans (database queries, outgoing HTTP calls)
and log correlation work as before.
"""
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.trace import NonRecordingSpan, SpanContext, SpanKind, Status, StatusCode, TraceFlags

_patched = False


def _parent_from(environ):
    tp = environ.get("HTTP_TRACEPARENT")
    if not tp or len(tp) < 55:
        return None
    try:
        version, trace_id, span_id, flags = tp.strip().split("-")[:4]
        if len(trace_id) != 32 or len(span_id) != 16 or version == "ff":
            return None
        tid, sid = int(trace_id, 16), int(span_id, 16)
        if not tid or not sid:
            return None
        sc = SpanContext(trace_id=tid, span_id=sid, is_remote=True, trace_flags=TraceFlags(int(flags[:2], 16)))
    except ValueError:
        return None
    return trace.set_span_in_context(NonRecordingSpan(sc))


def patch_flask():
    """Patch flask.Flask so every app gets the lean server span. Returns True when applied."""
    global _patched
    if _patched:
        return True
    try:
        import flask
    except ImportError:
        return False
    tracer = trace.get_tracer("datacat.flask")
    original_wsgi_app = flask.Flask.wsgi_app
    original_dispatch = flask.Flask.dispatch_request

    def wsgi_app(self, environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET")
        span = tracer.start_span(method, context=_parent_from(environ), kind=SpanKind.SERVER,
                                 attributes={"http.request.method": method, "url.path": environ.get("PATH_INFO", "/")})
        token = otel_context.attach(trace.set_span_in_context(span))
        status = [500]

        def _start_response(s, headers, exc_info=None):
            try:
                status[0] = int(s[:3])
            except ValueError:
                pass
            return start_response(s, headers, exc_info)

        try:
            return original_wsgi_app(self, environ, _start_response)
        except BaseException as exc:
            span.record_exception(exc)
            raise
        finally:
            code = status[0]
            span.set_attribute("http.response.status_code", code)
            if code >= 500:
                span.set_status(Status(StatusCode.ERROR))
            span.end()
            otel_context.detach(token)

    def dispatch_request(self, *args, **kwargs):
        try:
            rule = flask.request.url_rule
            if rule is not None:
                span = trace.get_current_span()
                route = rule.rule
                span.set_attribute("http.route", route)
                span.update_name(f"{flask.request.method} {route}")
        except Exception:
            pass
        return original_dispatch(self, *args, **kwargs)

    flask.Flask.wsgi_app = wsgi_app
    flask.Flask.dispatch_request = dispatch_request
    _patched = True
    return True

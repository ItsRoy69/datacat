"""Run with datacat-run python examples/app.py, then GET /work."""
import logging
import os
from flask import Flask
from datacat import tracer, metrics, shutdown

logging.basicConfig(level=logging.INFO)
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("datacat.example")
app = Flask(__name__)


@app.get("/work")
def work():
    with tracer.trace("example.work", resource="example", tags={"component": "example"}):
        metrics.increment("datacat.example.python.requests", tags={"route": "work"})
        metrics.gauge("datacat.example.python.queue", 2)
        metrics.histogram("datacat.example.python.duration", 12)
        logger.info("DataCat Python example request")
    return {"ok": True}


if __name__ == "__main__":
    import signal
    def stop(*_):
        shutdown()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8082")), use_reloader=False)

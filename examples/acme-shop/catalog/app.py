import json, logging, os, random, sqlite3, time
LOG_DIR = os.environ.get("ACME_LOG_DIR", "/tmp/acme-shop")
from flask import Flask, jsonify, abort

class JsonFormatter(logging.Formatter):
    def format(self, r):
        d = {"timestamp": self.formatTime(r), "level": r.levelname.lower(), "message": r.getMessage(), "service": "catalog-service"}
        for k in ("trace_id", "span_id"):
            if hasattr(r, k): d[k] = getattr(r, k)
        return json.dumps(d)
os.makedirs(LOG_DIR, exist_ok=True)
h = logging.FileHandler(os.path.join(LOG_DIR, "catalog-service.log")); h.setFormatter(JsonFormatter())
log = logging.getLogger("catalog"); log.setLevel(logging.INFO); log.addHandler(h)

DB = os.environ.get("ACME_CATALOG_DB", os.path.join(LOG_DIR, "catalog.db"))
con = sqlite3.connect(DB)
con.execute("create table if not exists products (id integer primary key, name text, price_cents int, stock int)")
if con.execute("select count(*) from products").fetchone()[0] == 0:
    names = ["Trail Runner", "Rain Shell", "Wool Socks", "Camp Mug", "Headlamp", "Day Pack", "Water Filter", "Fleece", "Beanie", "Trekking Poles"]
    con.executemany("insert into products (name, price_cents, stock) values (?,?,?)", [(f"{names[i % 10]} {i // 10 + 1}", random.randint(900, 18900), random.randint(0, 200)) for i in range(50)])
    con.commit()
con.close()

app = Flask(__name__)
def db(): return sqlite3.connect(DB)

@app.route("/products")
def products():
    rows = db().execute("select id, name, price_cents, stock from products order by id").fetchall()
    return jsonify([dict(id=r[0], name=r[1], price_cents=r[2], stock=r[3]) for r in rows])

@app.route("/product/<int:pid>")
def product(pid):
    if random.random() < 0.02: time.sleep(0.3)  # cold cache
    r = db().execute("select id, name, price_cents, stock from products where id = ?", (pid,)).fetchone()
    if not r:
        log.warning("unknown sku %s", pid); abort(404)
    if r[3] < 5: log.warning("low stock for %s: %s left", r[1], r[3])
    return jsonify(dict(id=r[0], name=r[1], price_cents=r[2], stock=r[3]))

if __name__ == "__main__":
    log.info("catalog-service listening on 4101")
    app.run(port=4101)

const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const log = require('../log')('cart-service');
const db = new Pool({ connectionString: process.env.ACME_DATABASE_URL || 'postgresql://localhost/shop', max: 5 });
const app = express(); app.use(express.json());
app.post('/cart', async (req, res) => {
  const { user, sku, qty = 1 } = req.body;
  await db.query('insert into carts (user_id, sku, qty) values ($1, $2, $3)', [user, String(sku), qty]);
  log.info('added to cart', { user, sku, qty });
  res.json({ ok: true });
});
app.get('/cart/:user', async (req, res) => {
  if (Math.random() < 0.03) await db.query('select pg_sleep(0.25)'); // occasional slow query
  // Incident demo: `bash bench/incident/inject.sh on` creates this flag and the "v2.1" cart query references a column
  // that does not exist (the kind of bug a bad deploy ships). `inject.sh off` removes it.
  const faulty = fs.existsSync('/tmp/acme-fault/cart-query');
  const sql = faulty ? 'select sku, sum(quantity)::int as qty from carts where user_id = $1 group by sku'
                     : 'select sku, sum(qty)::int as qty from carts where user_id = $1 group by sku';
  try {
    const r = await db.query(sql, [req.params.user]);
    res.json({ items: r.rows });
  } catch (e) {
    log.error('cart lookup failed: ' + e.message, { user: req.params.user, sql });
    res.status(500).json({ error: 'cart lookup failed' });
  }
});
app.delete('/cart/:user', async (req, res) => { await db.query('delete from carts where user_id = $1', [req.params.user]); res.json({ ok: true }); });
app.get('/orders/pending', async (req, res) => { const r = await db.query("select id, total_cents from orders where status = 'paid' order by id limit 20"); res.json({ orders: r.rows }); });
app.post('/orders/:id/fulfill', async (req, res) => { await db.query("update orders set status = 'fulfilled' where id = $1", [req.params.id]); res.json({ ok: true }); });
app.listen(4102, () => log.info('cart-service listening on 4102'));

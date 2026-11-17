const express = require('express');
const { Pool } = require('pg');
const log = require('../log')('payments-service');
const db = new Pool({ connectionString: process.env.ACME_DATABASE_URL || 'postgresql://localhost/shop', max: 5 });
const app = express(); app.use(express.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.get('/fraud-score', async (req, res) => { await sleep(15 + Math.random() * 40); res.json({ score: Math.random() }); });
app.post('/charge', async (req, res) => {
  const { user, total_cents } = req.body;
  const fraud = await (await fetch(`http://127.0.0.1:4103/fraud-score?user=${user}`)).json();
  await sleep(30 + Math.random() * 90 + (Math.random() < 0.02 ? 800 : 0)); // card network latency, rare slow outliers
  if (fraud.score > 0.94) { log.error('card declined: fraud score too high', { user, score: fraud.score }); return res.status(402).json({ reason: 'fraud_suspected' }); }
  if (Math.random() < 0.04) { log.error('card declined: insufficient funds', { user, total_cents }); return res.status(402).json({ reason: 'insufficient_funds' }); }
  const r = await db.query("insert into orders (user_id, total_cents, status) values ($1, $2, 'paid') returning id", [user, total_cents]);
  log.info('charge succeeded', { user, total_cents, order_id: r.rows[0].id });
  res.json({ order_id: r.rows[0].id });
});
app.listen(4103, () => log.info('payments-service listening on 4103'));

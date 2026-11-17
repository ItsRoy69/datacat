// Realistic shoppers: browse, view products (some unknown SKUs), add to cart, check out. Busier every few minutes.
const G = 'http://127.0.0.1:4100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(G + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).catch(() => {});
async function shopper(user) {
  await fetch(G + '/products').catch(() => {});
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const sku = Math.random() < 0.05 ? 60 + Math.floor(Math.random() * 20) : 1 + Math.floor(Math.random() * 50);
    await fetch(G + '/product/' + sku).catch(() => {});
    if (sku <= 50 && Math.random() < 0.7) await post('/cart', { user, sku, qty: 1 + Math.floor(Math.random() * 2) });
  }
  if (Math.random() < 0.8) await post('/checkout', { user });
}
(async () => {
  let user = 1000;
  while (true) {
    const burst = Math.floor(Date.now() / 60000) % 7 === 0 ? 3 : 1; // a busier minute every 7 minutes
    await Promise.all(Array.from({ length: burst }, () => shopper(user++ % 400)));
    await sleep(350 + Math.random() * 500);
  }
})();

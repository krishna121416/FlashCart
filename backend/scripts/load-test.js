/**
 * Flash-sale load test: fire far more concurrent buy requests than there is
 * stock, against a running FlashCart API, and report how many succeeded.
 *
 * Usage:
 *   node backend/scripts/load-test.js [--url http://localhost:4000] [--stock 10] [--requests 200]
 *   (or: npm run load-test -- --stock 10 --requests 200, from backend/)
 *
 * Requires the API (and Mongo/Redis) to already be running, e.g. via
 * `docker compose up` or `npm run dev` in backend/.
 */

const BASE_URL = argValue('--url') || 'http://localhost:4000';
const STOCK = Number(argValue('--stock') || 10);
const REQUEST_COUNT = Number(argValue('--requests') || 200);

function argValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? null : process.argv[idx + 1];
}

async function createProduct() {
  const res = await fetch(`${BASE_URL}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Flash Sale Item ${Date.now()}`, price: 999, stock: STOCK }),
  });
  if (!res.ok) throw new Error(`failed to create product: ${res.status}`);
  return res.json();
}

async function placeOrder(productId) {
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, quantity: 1 }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, ms: Date.now() - start, body };
  } catch (err) {
    return { status: 0, ms: Date.now() - start, error: err.message };
  }
}

async function getProduct(productId) {
  const res = await fetch(`${BASE_URL}/products/${productId}`);
  return res.json();
}

async function main() {
  console.log(`FlashCart load test`);
  console.log(`  target:    ${BASE_URL}`);
  console.log(`  stock:     ${STOCK}`);
  console.log(`  requests:  ${REQUEST_COUNT} (concurrent)\n`);

  console.log('Creating product...');
  const product = await createProduct();
  console.log(`  product_id: ${product._id}\n`);

  console.log(`Firing ${REQUEST_COUNT} concurrent POST /orders...`);
  const startedAt = Date.now();
  const results = await Promise.all(
    Array.from({ length: REQUEST_COUNT }, () => placeOrder(product._id))
  );
  const totalMs = Date.now() - startedAt;

  const succeeded = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  const errored = results.filter((r) => r.status !== 201 && r.status !== 409);

  const final = await getProduct(product._id);

  console.log('\nFlash Sale Load Test Results');
  console.log('-----------------------------');
  console.log(`Starting stock:          ${STOCK}`);
  console.log(`Concurrent requests:     ${REQUEST_COUNT}`);
  console.log(`Total wall time:         ${totalMs} ms`);
  console.log(`Successful reservations: ${succeeded.length}`);
  console.log(`Rejected requests:       ${rejected.length}`);
  console.log(`Other/errors:            ${errored.length}`);
  console.log(`Final available stock:   ${final.availableStock}`);
  console.log(`Oversold:                ${succeeded.length > STOCK ? 'YES' : 'NO'}`);
  console.log('-----------------------------\n');

  if (errored.length > 0) {
    console.log('Error/other responses (for diagnosis):');
    errored.forEach((r, i) => console.log(`  [${i}] status=${r.status} ${r.error || JSON.stringify(r.body)}`));
    console.log();
  }

  const pass = succeeded.length === STOCK && final.availableStock === 0 && errored.length === 0;
  console.log(pass ? 'PASS: sold exactly the available stock, never oversold.' : 'FAIL: see numbers above.');

  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exitCode = 1;
});

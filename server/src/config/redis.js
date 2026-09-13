const { createClient } = require('redis');

// Redis is used purely as a read-through cache for the "live stock" number
// (GET /products/:id) and is never on the critical path that decides whether
// an order succeeds - that decision is made entirely by MongoDB's atomic
// findOneAndUpdate. If Redis is down, the API keeps working, just without
// the cache speedup, because every cache call below is wrapped defensively.
let client = null;
let connecting = null;

function getClient() {
  if (client) return client;
  if (process.env.DISABLE_REDIS === 'true') return null;

  client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
  client.on('error', (err) => {
    console.warn('[redis] connection error (cache disabled until reconnect):', err.message);
  });

  if (!connecting) {
    connecting = client.connect().catch((err) => {
      console.warn('[redis] initial connect failed, continuing without cache:', err.message);
    });
  }
  return client;
}

const STOCK_TTL_SECONDS = 2; // short TTL: freshness matters more than hit rate during a flash sale

async function getCachedStock(productId) {
  try {
    const c = getClient();
    if (!c || !c.isReady) return null;
    const val = await c.get(`stock:${productId}`);
    return val === null ? null : JSON.parse(val);
  } catch (err) {
    return null;
  }
}

async function setCachedStock(productId, payload) {
  try {
    const c = getClient();
    if (!c || !c.isReady) return;
    await c.set(`stock:${productId}`, JSON.stringify(payload), { EX: STOCK_TTL_SECONDS });
  } catch (err) {
    // best-effort cache, ignore failures
  }
}

async function invalidateStock(productId) {
  try {
    const c = getClient();
    if (!c || !c.isReady) return;
    await c.del(`stock:${productId}`);
  } catch (err) {
    // best-effort cache, ignore failures
  }
}

async function closeRedis() {
  if (client) {
    try {
      await client.quit();
    } catch (err) {
      // ignore
    }
    client = null;
    connecting = null;
  }
}

module.exports = { getClient, getCachedStock, setCachedStock, invalidateStock, closeRedis };

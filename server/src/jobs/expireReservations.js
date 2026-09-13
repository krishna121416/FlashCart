const Order = require('../models/Order');
const Product = require('../models/Product');
const { invalidateStock } = require('../config/redis');

// Interval-based cleanup instead of a MongoDB TTL index.
//
// A TTL index only *deletes* the expired document - it can't also decrement
// `reserved` on the product in the same operation, and it runs on Mongo's own
// background schedule (roughly once a minute, not exact). Since releasing
// held stock back to other buyers is the whole point here, we need a step
// that finds expired reservations, flips them to 'expired', and decrements
// `reserved` on the product - three things a TTL index can't do together.
// A plain setInterval sweep does exactly that, on a schedule we control, and
// is trivial to explain and to unit test.
async function sweepExpiredReservations() {
  const now = new Date();
  const expired = await Order.find({ status: 'reserved', expires_at: { $lt: now } });

  let released = 0;
  for (const order of expired) {
    // Guard the update with status: 'reserved' so a reservation that gets
    // confirmed in the split second before the sweep runs isn't double-released.
    const result = await Order.updateOne(
      { _id: order._id, status: 'reserved' },
      { $set: { status: 'expired' } }
    );

    if (result.modifiedCount === 1) {
      await Product.updateOne({ _id: order.product_id }, { $inc: { reserved: -order.quantity } });
      await invalidateStock(String(order.product_id));
      released += 1;
    }
  }

  return released;
}

function startExpiryJob(intervalMs = 30 * 1000) {
  const handle = setInterval(() => {
    sweepExpiredReservations().catch((err) => {
      console.error('[expiry-job] sweep failed:', err.message);
    });
  }, intervalMs);
  handle.unref?.(); // don't keep the process alive just for this timer
  return handle;
}

module.exports = { sweepExpiredReservations, startExpiryJob };

const Order = require('../models/Order');
const Product = require('../models/Product');
const { invalidateStock } = require('../config/redis');

// A MongoDB TTL index can only delete the expired order document - it can't
// also decrement Product.reserved in the same operation, which is the whole
// point of releasing held stock back to other buyers. So instead we find
// orders whose hold has lapsed, flip them to 'expired', and release the
// stock, three plain steps a TTL index can't do together.
async function sweepExpiredReservations() {
  const now = new Date();
  const expired = await Order.find({ status: 'reserved', expires_at: { $lt: now } });

  let released = 0;
  for (const order of expired) {
    // Guarded by status: 'reserved' so an order confirmed a split-second
    // before the sweep runs can't be double-released.
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

module.exports = { sweepExpiredReservations };

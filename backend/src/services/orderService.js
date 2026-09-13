const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { AppError } = require('../utils/AppError');
const { invalidateStock } = require('../config/redis');

const RESERVATION_TTL_MS = Number(process.env.RESERVATION_TTL_MS) || 5 * 60 * 1000; // 5 minutes

// THE CORE OF THIS PROJECT — see README "Race condition" section for the
// full before/after explanation. Short version: the filter's stock check
// and the reserved increment happen as ONE atomic MongoDB operation, so two
// concurrent requests can never both read "enough stock" before either one
// writes. Whichever request reaches the document first wins; every request
// after the last unit is gone simply fails the filter.
async function reserveStock(productId, quantity) {
  if (!mongoose.isValidObjectId(productId)) {
    throw new AppError(400, 'invalid product_id');
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new AppError(400, 'quantity must be a positive integer');
  }

  const product = await Product.findOneAndUpdate(
    {
      _id: productId,
      // (stock - reserved) >= quantity, evaluated and applied atomically
      $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, quantity] },
    },
    { $inc: { reserved: quantity } },
    { new: true }
  );

  if (!product) {
    const exists = await Product.exists({ _id: productId });
    if (!exists) throw new AppError(404, 'product not found');
    throw new AppError(409, 'insufficient stock');
  }

  const now = Date.now();
  const order = await Order.create({
    product_id: productId,
    quantity,
    status: 'reserved',
    reserved_at: new Date(now),
    expires_at: new Date(now + RESERVATION_TTL_MS),
  });

  await invalidateStock(String(productId));
  return order;
}

// Only reserved -> confirmed is allowed. The hold becomes permanent: stock
// drops for good, reserved drops back down by the same amount it was
// bumped up by at reservation time.
async function confirmOrder(orderId) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new AppError(400, 'invalid order id');
  }

  const order = await Order.findById(orderId);
  if (!order) {
    throw new AppError(404, 'order not found');
  }
  if (order.status !== 'reserved') {
    throw new AppError(409, `cannot confirm order with status '${order.status}'`);
  }
  if (order.expires_at.getTime() < Date.now()) {
    throw new AppError(409, 'reservation has expired');
  }

  await Product.updateOne(
    { _id: order.product_id },
    { $inc: { stock: -order.quantity, reserved: -order.quantity } }
  );

  order.status = 'confirmed';
  order.confirmed_at = new Date();
  await order.save();

  await invalidateStock(String(order.product_id));
  return order;
}

async function getOrder(orderId) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw new AppError(400, 'invalid order id');
  }
  const order = await Order.findById(orderId);
  if (!order) {
    throw new AppError(404, 'order not found');
  }
  return order;
}

module.exports = { reserveStock, confirmOrder, getOrder, RESERVATION_TTL_MS };

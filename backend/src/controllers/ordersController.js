const orderService = require('../services/orderService');
const { asyncHandler } = require('../middleware/asyncHandler');
const { AppError } = require('../utils/AppError');

const createOrder = asyncHandler(async (req, res) => {
  const { product_id, quantity } = req.body;
  if (quantity === undefined) {
    throw new AppError(400, 'quantity is required');
  }
  const order = await orderService.reserveStock(product_id, quantity);
  res.status(201).json({
    orderId: order._id,
    status: order.status,
    quantity: order.quantity,
    expiresAt: order.expires_at,
  });
});

const confirmOrder = asyncHandler(async (req, res) => {
  const order = await orderService.confirmOrder(req.params.id);
  res.json(order);
});

const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.params.id);
  res.json(order);
});

module.exports = { createOrder, confirmOrder, getOrder };

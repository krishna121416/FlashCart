const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { invalidateStock } = require('../config/redis');

const router = express.Router();

const RESERVATION_TTL_MS = Number(process.env.RESERVATION_TTL_MS) || 5 * 60 * 1000; // 5 minutes

// POST /orders - reserve stock for a purchase.
//
// THE CORE OF THIS PROJECT:
//
// Naive (broken) approach:
//   const product = await Product.findById(id);              // READ
//   if (product.stock - product.reserved >= quantity) {       // CHECK
//     product.reserved += quantity;                           // WRITE
//     await product.save();
//   }
// Two requests can both READ the same "9 available" snapshot before either
// WRITEs. Both pass the CHECK. Both WRITE. You just oversold.
//
// Fix: fold the CHECK and the WRITE into a single atomic MongoDB operation.
// findOneAndUpdate's filter is evaluated by MongoDB's storage engine while it
// holds the per-document write lock, so no other request can interleave
// between "is there enough stock" and "reserve it". Whichever request
// arrives at the document first wins the last unit; every request after it
// simply fails the filter and matches nothing.
router.post('/', async (req, res) => {
  try {
    const { product_id, quantity } = req.body;

    if (!mongoose.isValidObjectId(product_id)) {
      return res.status(400).json({ error: 'invalid product_id' });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'quantity must be a positive integer' });
    }

    const product = await Product.findOneAndUpdate(
      {
        _id: product_id,
        // (stock - reserved) >= quantity, computed and checked atomically
        $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, quantity] },
      },
      { $inc: { reserved: quantity } },
      { new: true }
    );

    if (!product) {
      // Either the product doesn't exist, or the atomic filter failed
      // because there wasn't enough available stock. Tell them apart with
      // a cheap follow-up read (does not affect correctness either way).
      const exists = await Product.exists({ _id: product_id });
      if (!exists) {
        return res.status(404).json({ error: 'product not found' });
      }
      return res.status(409).json({ error: 'not enough stock available' });
    }

    const now = Date.now();
    const order = await Order.create({
      product_id,
      quantity,
      status: 'reserved',
      reserved_at: new Date(now),
      expires_at: new Date(now + RESERVATION_TTL_MS),
    });

    await invalidateStock(String(product_id));

    return res.status(201).json(order);
  } catch (err) {
    return res.status(500).json({ error: 'failed to create order', detail: err.message });
  }
});

// POST /orders/:id/confirm - simulate completed payment.
// The hold becomes permanent: stock goes down for good, reserved goes back
// down by the same amount it was bumped up by at reservation time.
router.post('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'invalid order id' });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'order not found' });
    }
    if (order.status !== 'reserved') {
      return res.status(409).json({ error: `cannot confirm order with status '${order.status}'` });
    }
    if (order.expires_at.getTime() < Date.now()) {
      return res.status(409).json({ error: 'reservation has expired' });
    }

    await Product.updateOne(
      { _id: order.product_id },
      { $inc: { stock: -order.quantity, reserved: -order.quantity } }
    );

    order.status = 'confirmed';
    order.confirmed_at = new Date();
    await order.save();

    await invalidateStock(String(order.product_id));

    return res.json(order);
  } catch (err) {
    return res.status(500).json({ error: 'failed to confirm order', detail: err.message });
  }
});

// GET /orders/:id - convenience lookup, useful for the frontend confirm step.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'invalid order id' });
    }
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ error: 'order not found' });
    }
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ error: 'failed to fetch order', detail: err.message });
  }
});

module.exports = router;

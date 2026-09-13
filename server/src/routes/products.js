const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const { getCachedStock, setCachedStock } = require('../config/redis');

const router = express.Router();

// POST /products - create a product with a starting stock count.
router.post('/', async (req, res) => {
  try {
    const { name, price, stock } = req.body;

    if (!name || typeof price !== 'number' || price < 0) {
      return res.status(400).json({ error: 'name and non-negative numeric price are required' });
    }
    if (!Number.isInteger(stock) || stock < 0) {
      return res.status(400).json({ error: 'stock must be a non-negative integer' });
    }

    const product = await Product.create({ name, price, stock, reserved: 0 });
    return res.status(201).json(product);
  } catch (err) {
    return res.status(500).json({ error: 'failed to create product', detail: err.message });
  }
});

// GET /products - list all products (for the storefront page).
router.get('/', async (req, res) => {
  try {
    const products = await Product.find().sort({ created_at: -1 });
    return res.json(products);
  } catch (err) {
    return res.status(500).json({ error: 'failed to list products', detail: err.message });
  }
});

// GET /products/:id - live stock = stock - reserved, so the frontend counter
// never shows units that are actually held in someone else's cart.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'invalid product id' });
    }

    const cached = await getCachedStock(id);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ error: 'product not found' });
    }

    const payload = {
      _id: product._id,
      name: product.name,
      price: product.price,
      available: product.stock - product.reserved,
    };

    await setCachedStock(id, payload);
    return res.json({ ...payload, cached: false });
  } catch (err) {
    return res.status(500).json({ error: 'failed to fetch product', detail: err.message });
  }
});

module.exports = router;

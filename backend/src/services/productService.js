const mongoose = require('mongoose');
const Product = require('../models/Product');
const { AppError } = require('../utils/AppError');
const { getCachedStock, setCachedStock } = require('../config/redis');

function validateNewProduct({ name, price, stock }) {
  if (!name || typeof name !== 'string') {
    throw new AppError(400, 'name is required');
  }
  if (typeof price !== 'number' || price < 0) {
    throw new AppError(400, 'price must be a non-negative number');
  }
  if (!Number.isInteger(stock) || stock < 0) {
    throw new AppError(400, 'stock must be a non-negative integer');
  }
}

async function createProduct({ name, price, stock }) {
  validateNewProduct({ name, price, stock });
  return Product.create({ name, price, stock, reserved: 0 });
}

async function listProducts() {
  return Product.find().sort({ created_at: -1 });
}

// available = stock - reserved, cached briefly in Redis so a room full of
// buyers polling the counter doesn't hammer MongoDB on every poll.
async function getProductView(id) {
  if (!mongoose.isValidObjectId(id)) {
    throw new AppError(400, 'invalid product id');
  }

  const cached = await getCachedStock(id);
  if (cached) return { ...cached, cached: true };

  const product = await Product.findById(id);
  if (!product) {
    throw new AppError(404, 'product not found');
  }

  const view = {
    id: product._id,
    name: product.name,
    price: product.price,
    availableStock: Math.max(0, product.stock - product.reserved),
  };

  await setCachedStock(id, view);
  return { ...view, cached: false };
}

module.exports = { createProduct, listProducts, getProductView };

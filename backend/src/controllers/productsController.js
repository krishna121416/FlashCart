const productService = require('../services/productService');
const { asyncHandler } = require('../middleware/asyncHandler');

const createProduct = asyncHandler(async (req, res) => {
  const product = await productService.createProduct(req.body);
  res.status(201).json(product);
});

const listProducts = asyncHandler(async (req, res) => {
  const products = await productService.listProducts();
  res.json(products);
});

const getProduct = asyncHandler(async (req, res) => {
  const view = await productService.getProductView(req.params.id);
  res.json(view);
});

module.exports = { createProduct, listProducts, getProduct };

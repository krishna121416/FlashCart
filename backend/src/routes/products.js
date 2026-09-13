const express = require('express');
const controller = require('../controllers/productsController');

const router = express.Router();

router.post('/', controller.createProduct);
router.get('/', controller.listProducts);
router.get('/:id', controller.getProduct);

module.exports = router;

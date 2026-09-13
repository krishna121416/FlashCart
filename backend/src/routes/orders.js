const express = require('express');
const controller = require('../controllers/ordersController');

const router = express.Router();

router.post('/', controller.createOrder);
router.get('/:id', controller.getOrder);
router.post('/:id/confirm', controller.confirmOrder);

module.exports = router;

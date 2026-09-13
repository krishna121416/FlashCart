const request = require('supertest');
const { createApp } = require('../src/app');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');
const { sweepExpiredReservations } = require('../src/services/expiryService');

const app = createApp();

describe('reservation expiry sweep', () => {
  test('an unconfirmed reservation past its expiry is released back to stock', async () => {
    const product = await Product.create({ name: 'Perishable', price: 15, stock: 2, reserved: 2 });
    const expiredOrder = await Order.create({
      product_id: product._id,
      quantity: 2,
      status: 'reserved',
      reserved_at: new Date(Date.now() - 10 * 60 * 1000),
      expires_at: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
    });

    const released = await sweepExpiredReservations();
    expect(released).toBe(1);

    const updatedOrder = await Order.findById(expiredOrder._id);
    expect(updatedOrder.status).toBe('expired');

    const updatedProduct = await Product.findById(product._id);
    expect(updatedProduct.reserved).toBe(0);
    expect(updatedProduct.stock - updatedProduct.reserved).toBe(2); // fully purchasable again
  });

  test('expired stock becomes purchasable again through the API', async () => {
    const product = await Product.create({ name: 'Recyclable', price: 8, stock: 1, reserved: 0 });

    // First buyer reserves the only unit, then their reservation lapses.
    const firstOrder = await request(app).post('/orders').send({ product_id: product._id, quantity: 1 });
    expect(firstOrder.status).toBe(201);

    await Order.updateOne({ _id: firstOrder.body.orderId }, { expires_at: new Date(Date.now() - 1000) });
    await sweepExpiredReservations();

    // A second buyer can now successfully reserve the released unit.
    const secondOrder = await request(app).post('/orders').send({ product_id: product._id, quantity: 1 });
    expect(secondOrder.status).toBe(201);
  });

  test('does not touch reservations that have not expired yet', async () => {
    const product = await Product.create({ name: 'Fresh', price: 8, stock: 1, reserved: 1 });
    await Order.create({
      product_id: product._id,
      quantity: 1,
      status: 'reserved',
      expires_at: new Date(Date.now() + 5 * 60 * 1000), // 5 min in the future
    });

    const released = await sweepExpiredReservations();
    expect(released).toBe(0);

    const updated = await Product.findById(product._id);
    expect(updated.reserved).toBe(1);
  });
});

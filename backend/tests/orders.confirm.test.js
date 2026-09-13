const request = require('supertest');
const { createApp } = require('../src/app');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');

const app = createApp();

describe('order confirmation', () => {
  test('confirming moves quantity from reserved to permanently-deducted stock', async () => {
    const product = await Product.create({ name: 'Confirmable', price: 20, stock: 5, reserved: 0 });

    const orderRes = await request(app).post('/orders').send({ product_id: product._id, quantity: 2 });
    expect(orderRes.status).toBe(201);
    expect(orderRes.body.status).toBe('reserved');

    let updated = await Product.findById(product._id);
    expect(updated.stock).toBe(5);
    expect(updated.reserved).toBe(2);

    const confirmRes = await request(app).post(`/orders/${orderRes.body.orderId}/confirm`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe('confirmed');
    expect(confirmRes.body.confirmed_at).not.toBeNull();

    updated = await Product.findById(product._id);
    expect(updated.stock).toBe(3); // permanently deducted
    expect(updated.reserved).toBe(0); // hold released
  });

  test('cannot confirm the same order twice', async () => {
    const product = await Product.create({ name: 'DoubleConfirm', price: 20, stock: 5, reserved: 0 });
    const orderRes = await request(app).post('/orders').send({ product_id: product._id, quantity: 1 });

    await request(app).post(`/orders/${orderRes.body.orderId}/confirm`);
    const second = await request(app).post(`/orders/${orderRes.body.orderId}/confirm`);

    expect(second.status).toBe(409);
  });

  test('cannot confirm a non-existent order', async () => {
    const res = await request(app).post('/orders/64b64b64b64b64b64b64b64b/confirm');
    expect(res.status).toBe(404);
  });

  test('cannot confirm a reservation past its expiry, even before the sweep job runs', async () => {
    const product = await Product.create({ name: 'LapsedHold', price: 20, stock: 5, reserved: 0 });
    const orderRes = await request(app).post('/orders').send({ product_id: product._id, quantity: 1 });
    expect(orderRes.status).toBe(201);

    // Simulate time passing without running the expiry sweep - the order
    // document itself is still 'reserved', only its expires_at has lapsed.
    await Order.updateOne({ _id: orderRes.body.orderId }, { expires_at: new Date(Date.now() - 1000) });

    const confirmRes = await request(app).post(`/orders/${orderRes.body.orderId}/confirm`);
    expect(confirmRes.status).toBe(409);

    const updated = await Product.findById(product._id);
    expect(updated.stock).toBe(5); // never permanently deducted
    expect(updated.reserved).toBe(1); // still held until the sweep releases it
  });
});

const request = require('supertest');
const { createApp } = require('../src/app');
const Product = require('../src/models/Product');

const app = createApp();

describe('order confirmation', () => {
  test('confirming moves quantity from reserved to permanently-deducted stock', async () => {
    const product = await Product.create({ name: 'Confirmable', price: 20, stock: 5, reserved: 0 });

    const orderRes = await request(app).post('/orders').send({ product_id: product._id, quantity: 2 });
    expect(orderRes.status).toBe(201);

    let updated = await Product.findById(product._id);
    expect(updated.stock).toBe(5);
    expect(updated.reserved).toBe(2);

    const confirmRes = await request(app).post(`/orders/${orderRes.body._id}/confirm`);
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

    await request(app).post(`/orders/${orderRes.body._id}/confirm`);
    const second = await request(app).post(`/orders/${orderRes.body._id}/confirm`);

    expect(second.status).toBe(409);
  });

  test('cannot confirm a non-existent order', async () => {
    const res = await request(app).post('/orders/64b64b64b64b64b64b64b64b/confirm');
    expect(res.status).toBe(404);
  });
});

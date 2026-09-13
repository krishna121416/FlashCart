const request = require('supertest');
const { createApp } = require('../src/app');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');

const app = createApp();

describe('order reservation - overselling protection', () => {
  test('two simultaneous requests for the last unit: only one succeeds', async () => {
    const product = await Product.create({ name: 'Last Unit', price: 10, stock: 1, reserved: 0 });

    const [resA, resB] = await Promise.all([
      request(app).post('/orders').send({ product_id: product._id, quantity: 1 }),
      request(app).post('/orders').send({ product_id: product._id, quantity: 1 }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const updated = await Product.findById(product._id);
    expect(updated.reserved).toBe(1); // exactly one reservation held, never two
  });

  test('200 concurrent requests against 10 units: exactly 10 succeed', async () => {
    const product = await Product.create({ name: 'Flash Sale Item', price: 25, stock: 10, reserved: 0 });

    const requests = Array.from({ length: 200 }, () =>
      request(app).post('/orders').send({ product_id: product._id, quantity: 1 })
    );
    const results = await Promise.all(requests);

    const succeeded = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 409);

    expect(succeeded.length).toBe(10);
    expect(rejected.length).toBe(190);

    const updated = await Product.findById(product._id);
    expect(updated.reserved).toBe(10);
    expect(updated.stock - updated.reserved).toBe(0); // never negative, never over

    const orders = await Order.find({ product_id: product._id });
    expect(orders.length).toBe(10);
  });

  test('a single request that asks for more than is available is rejected atomically', async () => {
    const product = await Product.create({ name: 'Scarce', price: 5, stock: 3, reserved: 0 });

    const res = await request(app).post('/orders').send({ product_id: product._id, quantity: 4 });
    expect(res.status).toBe(409);

    const updated = await Product.findById(product._id);
    expect(updated.reserved).toBe(0);
  });
});

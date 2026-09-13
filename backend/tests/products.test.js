const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp();

describe('products API', () => {
  test('POST /products creates a product', async () => {
    const res = await request(app).post('/products').send({ name: 'Widget', price: 99, stock: 10 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Widget');
    expect(res.body.stock).toBe(10);
    expect(res.body.reserved).toBe(0);
  });

  test('POST /products rejects invalid stock', async () => {
    const res = await request(app).post('/products').send({ name: 'Bad', price: 10, stock: -1 });
    expect(res.status).toBe(400);
  });

  test('GET /products/:id returns live stock (stock - reserved)', async () => {
    const create = await request(app).post('/products').send({ name: 'Gadget', price: 50, stock: 10 });
    const id = create.body._id;

    await request(app).post('/orders').send({ product_id: id, quantity: 3 });

    const res = await request(app).get(`/products/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.availableStock).toBe(7);
  });

  test('GET /products/:id 404s for missing product', async () => {
    const res = await request(app).get('/products/64b64b64b64b64b64b64b64b');
    expect(res.status).toBe(404);
  });
});

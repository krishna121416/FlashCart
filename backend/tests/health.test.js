const request = require('supertest');
const { createApp } = require('../src/app');

const app = createApp();

describe('GET /api/health', () => {
  test('reports database connected and a redis status without crashing', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('connected');
    expect(['connected', 'disconnected', 'disabled']).toContain(res.body.redis);
  });
});

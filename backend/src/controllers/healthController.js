const { getHealth } = require('../services/healthService');

function getHealthStatus(req, res) {
  const health = getHealth();
  // Mongo is the source of truth for inventory, so its absence is the only
  // thing that makes this API actually unhealthy; a missing Redis just
  // degrades cache speed (see config/redis.js).
  const httpStatus = health.database === 'connected' ? 200 : 503;
  res.status(httpStatus).json(health);
}

module.exports = { getHealthStatus };

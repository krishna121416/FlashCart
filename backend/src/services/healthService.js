const mongoose = require('mongoose');
const { getRedisStatus } = require('../config/redis');

function getHealth() {
  const mongoConnected = mongoose.connection.readyState === 1; // 1 = connected
  const redisStatus = getRedisStatus();

  return {
    status: mongoConnected ? 'ok' : 'degraded',
    database: mongoConnected ? 'connected' : 'disconnected',
    redis: redisStatus,
  };
}

module.exports = { getHealth };

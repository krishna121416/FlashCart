const { sweepExpiredReservations } = require('../services/expiryService');

// Interval-based cleanup instead of a MongoDB TTL index - see
// expiryService.js for why. Runs every 30s by default; configurable for
// tests that need a much shorter cycle.
function startExpiryJob(intervalMs = Number(process.env.EXPIRY_SWEEP_INTERVAL_MS) || 30 * 1000) {
  const handle = setInterval(() => {
    sweepExpiredReservations().catch((err) => {
      console.error('[expiry-job] sweep failed:', err.message);
    });
  }, intervalMs);
  handle.unref?.(); // don't keep the process alive just for this timer
  return handle;
}

module.exports = { startExpiryJob };

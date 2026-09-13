require('dotenv').config();
const { createApp } = require('./src/app');
const { connectDB } = require('./src/config/db');
const { startExpiryJob } = require('./src/jobs/expireReservations');

const PORT = process.env.PORT || 4000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/flashcart';

async function main() {
  await connectDB(MONGO_URI);
  startExpiryJob();

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[flashcart] API listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('[flashcart] failed to start:', err);
  process.exit(1);
});

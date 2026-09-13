const mongoose = require('mongoose');

async function connectDB(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log(`[mongo] connected to ${uri}`);
  return mongoose.connection;
}

module.exports = { connectDB };

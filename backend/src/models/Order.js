const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  quantity: { type: Number, required: true, min: 1 },
  status: {
    type: String,
    enum: ['reserved', 'confirmed', 'expired', 'cancelled'],
    default: 'reserved',
  },
  reserved_at: { type: Date, default: Date.now },
  confirmed_at: { type: Date, default: null },
  expires_at: { type: Date, required: true },
});

orderSchema.index({ status: 1, expires_at: 1 }); // used by the expiry sweep job

module.exports = mongoose.model('Order', orderSchema);

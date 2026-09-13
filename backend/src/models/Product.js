const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  price: { type: Number, required: true, min: 0 },
  stock: { type: Number, required: true, min: 0 }, // permanently sold units already deducted
  reserved: { type: Number, required: true, default: 0, min: 0 }, // held by unconfirmed orders
  created_at: { type: Date, default: Date.now },
});

// Live, purchasable stock is always derived - never stored redundantly.
productSchema.virtual('available').get(function () {
  return this.stock - this.reserved;
});

productSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);

import { useEffect, useState } from 'react';
import { api } from '../api';

export default function ProductCard({ product, onOrderPlaced }) {
  const [available, setAvailable] = useState(product.available ?? product.stock - product.reserved);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [lastOrder, setLastOrder] = useState(null);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const fresh = await api.getProduct(product._id);
        setAvailable(fresh.available);
      } catch {
        // transient poll failure, ignore
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [product._id]);

  async function handleBuy() {
    setBusy(true);
    setMessage(null);
    try {
      const order = await api.createOrder(product._id, quantity);
      setLastOrder(order);
      setMessage({ type: 'success', text: `Reserved! Order ${order._id} holds ${order.quantity} unit(s). Confirm within 5 minutes.` });
      const fresh = await api.getProduct(product._id);
      setAvailable(fresh.available);
      onOrderPlaced?.(order);
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!lastOrder) return;
    setBusy(true);
    try {
      const confirmed = await api.confirmOrder(lastOrder._id);
      setLastOrder(confirmed);
      setMessage({ type: 'success', text: `Order confirmed! Payment complete.` });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  const soldOut = available <= 0;

  return (
    <div className="card">
      <h3>{product.name}</h3>
      <p className="price">₹{product.price}</p>
      <p className={`stock ${soldOut ? 'sold-out' : available <= 5 ? 'low' : ''}`}>
        {soldOut ? 'Sold out' : `${available} left`}
      </p>

      <div className="buy-row">
        <input
          type="number"
          min="1"
          value={quantity}
          onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
          disabled={busy || soldOut}
        />
        <button onClick={handleBuy} disabled={busy || soldOut}>
          {busy ? '...' : 'Buy'}
        </button>
      </div>

      {lastOrder && lastOrder.status === 'reserved' && (
        <button className="confirm-btn" onClick={handleConfirm} disabled={busy}>
          Confirm order {lastOrder._id.slice(-6)}
        </button>
      )}

      {message && <p className={`message ${message.type}`}>{message.text}</p>}
    </div>
  );
}

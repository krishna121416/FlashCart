const BASE_URL = import.meta.env.VITE_API_URL || '';

async function request(path, options) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  listProducts: () => request('/products'),
  getProduct: (id) => request(`/products/${id}`),
  createOrder: (product_id, quantity) =>
    request('/orders', { method: 'POST', body: JSON.stringify({ product_id, quantity }) }),
  confirmOrder: (id) => request(`/orders/${id}/confirm`, { method: 'POST' }),
  getOrder: (id) => request(`/orders/${id}`),
};

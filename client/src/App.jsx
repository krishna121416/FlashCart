import { useEffect, useState } from 'react';
import { api } from './api';
import ProductCard from './components/ProductCard.jsx';

export default function App() {
  const [products, setProducts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listProducts()
      .then(setProducts)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="app">
      <header>
        <h1>⚡ FlashCart</h1>
        <p>Flash-sale-safe inventory demo</p>
      </header>

      {loading && <p>Loading products...</p>}
      {error && <p className="message error">{error}</p>}

      <div className="grid">
        {products.map((p) => (
          <ProductCard key={p._id} product={p} />
        ))}
      </div>

      {!loading && products.length === 0 && !error && (
        <p>No products yet. Create one with POST /products.</p>
      )}
    </div>
  );
}

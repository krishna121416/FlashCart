# FlashCart

An e-commerce inventory system built to survive a flash sale: many buyers
hitting "Buy" on the last few units at the same instant, without ever
selling more than exists.

It's a small, fully-explainable monolith on purpose. No Kafka, no
Kubernetes, no microservices, no distributed locking. The one hard problem
this project solves - **preventing overselling under concurrency** - is
solved with a single correctly-shaped database query, not extra
infrastructure.

**Stack:** Node.js, Express, MongoDB (Mongoose), Redis, React (Vite), Docker
Compose, Jest + Supertest.

---

## The problem, in plain terms

Ten units of a product are left. A thousand people click "Buy" within the
same second. The system must:

- Sell **exactly** 10 units - never 11 (overselling: refunds, angry
  customers, broken trust).
- Never silently drop a legitimate request that arrived while stock was
  genuinely available (lost sales, also broken trust).

The naive way to write this is:

```js
// BROKEN - do not do this
const product = await Product.findById(id);                 // 1. READ
if (product.stock - product.reserved >= quantity) {          // 2. CHECK
  product.reserved += quantity;                              // 3. WRITE
  await product.save();
}
```

Walk through what happens when two requests for the last unit arrive within
milliseconds of each other:

| time | request A | request B |
|------|-----------|-----------|
| t0 | READ: available = 1 | |
| t1 | | READ: available = 1 |
| t2 | CHECK: 1 >= 1, passes | |
| t3 | | CHECK: 1 >= 1, passes |
| t4 | WRITE: reserved += 1 | |
| t5 | | WRITE: reserved += 1 |

Both requests read the same "1 available" snapshot *before either one
writes anything back*. Both pass the check. Both write. You just sold one
unit twice. Adding a `setTimeout`, doing the check in application memory, or
"just being fast" doesn't fix this - it's a race condition baked into the
shape of the code: read, then check, then write, as three separate steps
that other requests can interleave with.

## The fix: one atomic operation

```js
// CORRECT
const product = await Product.findOneAndUpdate(
  {
    _id: product_id,
    // (stock - reserved) >= quantity - evaluated by MongoDB itself
    $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, quantity] },
  },
  { $inc: { reserved: quantity } },
  { new: true }
);

if (!product) {
  // filter failed: not enough stock (or product doesn't exist)
  return res.status(409).json({ error: 'not enough stock available' });
}
```

`findOneAndUpdate` sends the **filter and the update together as one
request** to MongoDB. MongoDB's storage engine holds the per-document write
lock while it evaluates the filter and applies the update, so there is no
window where a second request can sneak in between "check" and "write" -
because from the database's point of view, they're not two steps anymore.
Whichever request reaches the document first gets it; MongoDB simply
processes concurrent writes to the same document one at a time, in some
order, and every request after the 10th no longer matches the filter (its
`$expr` evaluates false), so it fails fast and cleanly with a `409` instead
of oversubscribing the product.

This is the single most important line of code in the project. Everything
else - orders, expiry, the frontend counter - exists in service of getting
to call this one operation correctly.

**Why MongoDB and not, say, Postgres with `SELECT ... FOR UPDATE`?** Both
approaches solve the race correctly. MongoDB's document-level atomic
`findOneAndUpdate` maps onto this specific problem (a single counter-like
field on a single document) with no explicit transaction/locking code
needed, which is exactly the "smallest correct solution" this project is
going for. A row-locking transaction in a relational database would work
too, just with more ceremony for what is fundamentally a one-document
update.

## Reservation and expiry flow

Stock isn't decremented the instant someone clicks "Buy" - it's *reserved*.
This models a real checkout: you hold the item while the buyer pays, but
release it if they abandon the cart.

```
                 POST /orders                    POST /orders/:id/confirm
                 (atomic reserve)                 (payment "succeeds")
Product.stock ----------------------------------------> Product.stock -= qty
Product.reserved += qty                                  Product.reserved -= qty
Order.status = 'reserved'                                 Order.status = 'confirmed'
Order.expires_at = now + 5min

        |
        | 5 minutes pass, buyer never confirms
        v
  expiry sweep job finds it, flips status -> 'expired',
  Product.reserved -= qty   (stock is released back for other buyers)
```

- `stock` only ever decreases when an order is **confirmed** - it's the
  permanent, "actually sold" count.
- `reserved` is a temporary hold, incremented at reservation time and
  released (by either confirm or expiry) back to zero for that order.
- Live purchasable stock shown to buyers is always `stock - reserved`,
  computed on read, never stored as its own number that could drift out of
  sync.

**Why an interval job instead of a MongoDB TTL index?** A TTL index can only
*delete* the expired document once its background sweep gets around to it
(on Mongo's own schedule, not exact, roughly once a minute). It can't also
decrement `Product.reserved` in the same operation - and releasing the held
stock back to other buyers is the entire point of expiry here. So instead,
`server/src/jobs/expireReservations.js` runs a plain `setInterval` every 30
seconds that:

1. Finds orders where `status: 'reserved'` and `expires_at < now`.
2. Flips each to `status: 'expired'` - guarded by an extra `status:
   'reserved'` filter on the update, so an order that got confirmed a
   split-second before the sweep runs can't be double-released.
3. Decrements `Product.reserved` by that order's quantity.

It's three plain, testable steps instead of relying on Mongo's internal
janitor - easier to explain, easier to unit test deterministically (see
`server/tests/orders.expiry.test.js`), and it's the piece that actually
frees the stock, not just tidies up a document.

## Where Redis fits (and where it deliberately doesn't)

Redis caches the response of `GET /products/:id` for 2 seconds, so a page
full of shoppers polling the live counter doesn't hammer MongoDB on every
poll. That's it. It is **not** used for locking, queuing, or deciding
whether an order succeeds - that decision is made entirely by the single
atomic MongoDB operation above. The cache is invalidated on every
reservation, confirmation, and expiry, and if Redis is unreachable the API
keeps working correctly, just without the cache speedup (every cache call is
wrapped defensively and fails open).

## Data model

```
products
  _id
  name
  price
  stock       // permanently sold units already deducted
  reserved    // held by unconfirmed reservations
  created_at

orders
  _id
  product_id
  quantity
  status       // 'reserved' | 'confirmed' | 'expired' | 'cancelled'
  reserved_at
  confirmed_at
  expires_at
```

## API

| Method | Path | Description |
|---|---|---|
| POST | `/products` | Create a product: `{ name, price, stock }` |
| GET | `/products` | List all products |
| GET | `/products/:id` | Live stock: `{ ..., available: stock - reserved }` |
| POST | `/orders` | Reserve stock: `{ product_id, quantity }` -> `201` or `409` |
| GET | `/orders/:id` | Fetch one order |
| POST | `/orders/:id/confirm` | Confirm payment, permanently deduct stock |

## Running it locally

**With Docker (recommended - one command):**

```bash
docker compose up --build
```

This starts MongoDB, Redis, the API (port `4000`), and the React client
(port `5173`).

**Without Docker (need Mongo + Redis running locally):**

```bash
# terminal 1
cd server
npm install
cp .env.example .env
npm run dev

# terminal 2
cd client
npm install
npm run dev
```

Then open http://localhost:5173.

## Tests

```bash
cd server
npm test
```

Runs against an in-memory MongoDB (`mongodb-memory-server`), so no external
services are needed. Covers:

- **The race**: two simultaneous requests for the last unit -> exactly one
  succeeds (`tests/orders.race.test.js`).
- **The flash sale itself**: 200 concurrent requests against 10 units of
  stock -> exactly 10 succeed, 190 rejected, `reserved` never exceeds
  `stock` (same file).
- **Expiry**: an unconfirmed reservation past its `expires_at` is released
  back and becomes purchasable again (`tests/orders.expiry.test.js`).
- **Confirmation**: confirming an order correctly moves quantity from
  `reserved` to permanently-deducted `stock`, and can't be done twice
  (`tests/orders.confirm.test.js`).

## Load test: proof, not a claim

`loadtest/loadtest.js` creates a product with 10 units of stock and fires
200 concurrent `POST /orders` requests at a **running** instance of the API
(via Docker Compose), simulating 20x more demand than supply.

```bash
docker compose up -d --build
node loadtest/loadtest.js --url http://localhost:4000 --stock 10 --requests 200
```

### Result

Run against the full Docker Compose stack on this machine (Mongo + Redis +
API, product seeded with 10 units of stock):

```
$ node loadtest/loadtest.js --url http://localhost:4000 --stock 10 --requests 200

FlashCart load test
  target:    http://localhost:4000
  stock:     10
  requests:  200 (concurrent)

Creating product...
  product_id: 6aa6daf3c54c0614cc656b25

Firing 200 concurrent POST /orders...

--- RESULTS ---
Total wall time:        582 ms
Requests sent:          200
Succeeded (201):        10
Rejected - no stock (409): 190
Other/errors:           0
Final available stock:  0
----------------

PASS: sold exactly the available stock, never oversold.
```

Re-run at 5x the demand (1,000 concurrent requests against the same 10
units) to confirm it isn't a fluke of request count:

```
$ node loadtest/loadtest.js --url http://localhost:4000 --stock 10 --requests 1000

Requests sent:          1000
Succeeded (201):        10
Rejected - no stock (409): 990
Other/errors:           0
Final available stock:  0

PASS: sold exactly the available stock, never oversold.
```

In both runs: exactly 10 orders succeeded, every remaining request was
cleanly rejected with `409 Not enough stock available`, `Product.reserved`
never exceeded `Product.stock`, and final live stock settled at exactly `0`
- never negative, never oversold, regardless of how much demand was thrown
at it.

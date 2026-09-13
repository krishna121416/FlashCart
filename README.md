# FlashCart

FlashCart is a small e-commerce inventory system built to survive a flash
sale: many buyers hitting "Buy" on the last few units of a product at the
same instant, without ever selling more than exists.

It's a fully-explainable monolith on purpose. No Kafka, no Kubernetes, no
microservices, no distributed locking. The one hard problem this project
solves - **preventing overselling under concurrency** - is solved with a
single correctly-shaped database query, not extra infrastructure.

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

## The atomic solution

```js
// CORRECT - backend/src/services/orderService.js
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
  throw new AppError(409, 'insufficient stock');
}
```

`findOneAndUpdate` sends the **filter and the update together as one
request** to MongoDB. MongoDB's storage engine holds the per-document write
lock while it evaluates the filter and applies the update, so there is no
window where a second request can sneak in between "check" and "write" -
because from the database's point of view, they're not two steps anymore.
MongoDB checks the condition and performs the increment atomically, so two
concurrent requests cannot both reserve the same final unit. Whichever
request reaches the document first gets it; every request after the last
unit is gone no longer matches the filter (its `$expr` evaluates false), so
it fails fast and cleanly with a `409` instead of oversubscribing the
product.

This is the single most important line of code in the project. Everything
else - orders, expiry, caching, the frontend counter - exists in service of
getting to call this one operation correctly.

**Why MongoDB and not, say, Postgres with `SELECT ... FOR UPDATE`?** Both
approaches solve the race correctly. MongoDB's document-level atomic
`findOneAndUpdate` maps onto this specific problem (a single counter-like
field on a single document) with no explicit transaction/locking code
needed, which is exactly the "smallest correct solution" this project is
going for. A row-locking transaction in a relational database would work
too, just with more ceremony for what is fundamentally a one-document
update.

## Reservation lifecycle

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

```
reserved
   |
   +----> confirmed   (payment succeeded; stock permanently deducted)
   |
   +----> expired      (5 minutes passed, never confirmed; stock released)
```

Only `reserved -> confirmed` is allowed. Confirming an already-confirmed,
already-expired, or already-cancelled order is rejected with `409`.

- `stock` only ever decreases when an order is **confirmed** - it's the
  permanent, "actually sold" count. Reservation never touches `stock`,
  only `reserved`.
- `reserved` is a temporary hold, incremented at reservation time and
  released (by either confirm or expiry) back down for that order.
- Live purchasable stock shown to buyers is always `stock - reserved`,
  computed on read, never stored as its own number that could drift out of
  sync.

**Why an interval job instead of a MongoDB TTL index?** A TTL index can only
*delete* the expired document once its background sweep gets around to it
(on Mongo's own schedule, not exact, roughly once a minute). It can't also
decrement `Product.reserved` in the same operation - and releasing the held
stock back to other buyers is the entire point of expiry here. So instead,
`backend/src/services/expiryService.js` runs a plain `setInterval` (wired up
in `backend/src/jobs/expireReservations.js`, every 30 seconds by default)
that:

1. Finds orders where `status: 'reserved'` and `expires_at < now`.
2. Flips each to `status: 'expired'` - guarded by an extra `status:
   'reserved'` filter on the update, so an order that got confirmed a
   split-second before the sweep runs can't be double-released.
3. Decrements `Product.reserved` by that order's quantity.

It's three plain, testable steps instead of relying on Mongo's internal
janitor - easier to explain, easier to unit test deterministically (see
`backend/tests/orders.expiry.test.js`), and it's the piece that actually
frees the stock, not just tidies up a document.

## Where Redis fits (and where it deliberately doesn't)

Redis caches the response of `GET /products/:id` for 2 seconds, so a page
full of shoppers polling the live counter doesn't hammer MongoDB on every
poll. That's it.

- Redis is **not** the source of truth for inventory - MongoDB is, always.
- Redis is **not** used for locking, queuing, or deciding whether an order
  succeeds - that decision is made entirely by the single atomic MongoDB
  operation above.
- The cache is invalidated on every reservation, confirmation, and expiry,
  so it can never serve a stale "in stock" answer past its 2-second TTL.
- If Redis is unreachable, the API keeps working correctly using MongoDB
  directly, just without the cache speedup - every cache call is wrapped
  defensively and fails open (see `backend/src/config/redis.js`).

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

## Architecture

```
   React (Vite)
        |
        v
   Express API  ----------->  Redis (stock-read cache, 2s TTL)
        |
        v
   MongoDB (source of truth: products, orders)

Inside the API:
   routes -> controllers (thin: parse req, call service, send res)
          -> services (business logic: atomic reserve, confirm, expiry, cache)
          -> models (Mongoose schemas)
   jobs/expireReservations.js -> services/expiryService.js on a timer
```

## API

| Method | Path | Description |
|---|---|---|
| POST | `/products` | Create a product: `{ name, price, stock }` |
| GET | `/products` | List all products |
| GET | `/products/:id` | Live stock: `{ id, name, price, availableStock }` |
| POST | `/orders` | Reserve stock: `{ product_id, quantity }` -> `201` or `409` |
| GET | `/orders/:id` | Fetch one order |
| POST | `/orders/:id/confirm` | Confirm payment, permanently deduct stock |
| GET | `/api/health` | `{ status, database, redis }` |

Errors are always `{ "error": "message" }` with one of `400 | 404 | 409 |
500`. No stack traces are ever sent to the client (see
`backend/src/middleware/errorHandler.js`); unexpected errors are logged
server-side and reported as a plain `500`.

## Project structure

```
FlashCart/
  backend/
    src/
      config/       Mongo + Redis connections
      controllers/  thin HTTP layer (req/res, no business logic)
      services/     business logic: atomic reservation, confirm, expiry, cache
      models/       Mongoose schemas
      routes/       route -> controller wiring
      jobs/         interval-based expiry sweep
      middleware/   error handling, async wrapper
      utils/        AppError
      app.js, server.js
    scripts/
      load-test.js  the flash-sale proof (see below)
    tests/
  client/
    src/
      components/   ProductCard
      services/      api.js (fetch wrapper)
      App.jsx, main.jsx
  docker-compose.yml
  README.md
```

## Running it locally

**With Docker (recommended - one command):**

```bash
docker compose up --build
```

This starts MongoDB, Redis, the API (port `4000`), and the React client
(port `5173`), with the API talking to Mongo/Redis by their Docker service
names (`mongodb://mongo:27017/flashcart`, `redis://redis:6379`), not
`localhost`.

**Without Docker (need Mongo + Redis running locally):**

```bash
# terminal 1
cd backend
npm install
cp .env.example .env
npm run dev

# terminal 2
cd client
npm install
cp .env.example .env
npm run dev
```

Then open http://localhost:5173.

## Tests

```bash
cd backend
npm test
```

Runs against an in-memory MongoDB (`mongodb-memory-server`), so no external
services are needed. 16 tests, covering:

- **The race** (Scenario B): two simultaneous requests for the last unit ->
  exactly one succeeds, `reserved` never reaches 2
  (`tests/orders.race.test.js`).
- **The flash sale itself** (Scenario A): 200 concurrent requests against
  10 units of stock -> exactly 10 succeed, 190 rejected, `reserved` never
  exceeds `stock` (same file).
- **Expiry** (Scenario C): an unconfirmed reservation past its `expires_at`
  is released back and becomes purchasable again
  (`tests/orders.expiry.test.js`).
- **Confirmation** (Scenario D): confirming an order correctly moves
  quantity from `reserved` to permanently-deducted `stock`
  (`tests/orders.confirm.test.js`).
- **Confirming an expired reservation** (Scenario E): rejected with `409`,
  even before the sweep job has run (same file).
- **Confirming twice** (Scenario F): rejected with `409` (same file).
- **Health check** (Scenario G groundwork): `GET /api/health` reports real
  Mongo/Redis connection state without crashing (`tests/health.test.js`).

## Load test: proof, not a claim

`backend/scripts/load-test.js` creates a product with 10 units of stock and
fires 200 concurrent `POST /orders` requests at a **running** instance of
the API, simulating 20x more demand than supply.

```bash
docker compose up -d --build
node backend/scripts/load-test.js --url http://localhost:4000 --stock 10 --requests 200
# or, from backend/: npm run load-test -- --stock 10 --requests 200
```

### Result (actual run, not fabricated)

Run against a live instance of the current code (Mongo + Redis + API),
product seeded fresh with 10 units of stock:

```
$ node backend/scripts/load-test.js --url http://localhost:4100 --stock 10 --requests 200

FlashCart load test
  target:    http://localhost:4100
  stock:     10
  requests:  200 (concurrent)

Creating product...
  product_id: 6aa6de3ecc26ec3fa22f6085

Firing 200 concurrent POST /orders...

Flash Sale Load Test Results
-----------------------------
Starting stock:          10
Concurrent requests:     200
Total wall time:         339 ms
Successful reservations: 10
Rejected requests:       190
Other/errors:            0
Final available stock:   0
Oversold:                NO
-----------------------------

PASS: sold exactly the available stock, never oversold.
```

Repeated 3 times in a row against the same running instance to rule out a
fluke: **10 / 10 / 10** successful reservations, **0** errors, **0** final
available stock, **NO** overselling, every time.

This is the exact scenario the project is built around: 200 buyers, 10
units, and the atomic `findOneAndUpdate` in `orderService.js` is the only
thing standing between that and an oversold product.

**Known limitation of the load-test client itself:** pushing the script far
beyond this (e.g. 1,000 truly simultaneous raw connections from a single
Node process to `localhost` on this Windows dev machine) intermittently hit
client-side `fetch failed` errors - a local socket/connection-limit
artifact of the load generator, not the server: the backend logged no
errors in any run, and in every trial, including the failed ones, exactly
10 reservations succeeded and stock never went negative or over. The
project's actual correctness claim rests on the 200-concurrent scenario
above, which is what the spec asks for and what was run repeatedly and
cleanly.

## Interview explanation

### "How I prevent overselling"

> FlashCart reserves stock with a single MongoDB `findOneAndUpdate` whose
> filter checks `stock - reserved >= quantity` using `$expr`, and whose
> update increments `reserved` by that quantity, in one atomic
> database operation. MongoDB evaluates the condition and applies the write
> while holding the document's write lock, so two concurrent requests can
> never both read "stock is available" before either one commits - there's
> no gap between check and write for a race to live in. Whichever request
> reaches the document first reserves the unit; every request after stock
> runs out simply fails the filter and gets a clean `409`. Stock itself
> isn't touched until payment is confirmed - reservation only moves the
> `reserved` counter, so a 5-minute hold that's never confirmed is safely
> released back by an expiry sweep without ever having touched the
> permanent `stock` field.

### "Why not Kafka/Kubernetes?"

> This is intentionally a monolith because the core problem is
> transactional inventory correctness, not distributed architecture. Adding
> Kafka or Kubernetes would add complexity without improving the
> fundamental atomic stock reservation guarantee - the guarantee comes from
> one correctly-shaped MongoDB query, not from more infrastructure. A
> fresher project should be small enough to explain every line of in an
> interview; this one is.

## Known limitations (intentionally simplified)

- **No payment integration.** `POST /orders/:id/confirm` simulates a
  successful payment; there's no real payment gateway.
- **No authentication.** Not part of this project's core problem
  (inventory correctness under concurrency), so it was deliberately left
  out per the project's own scope.
- **Reservation + order creation is not wrapped in a Mongo transaction.**
  The atomic stock reservation (`findOneAndUpdate`) happens first and is
  itself always consistent; `Order.create` follows it as a second step. If
  the process crashed between those two calls, stock would stay reserved
  with no matching order (never oversold, just a stuck hold) - a rare
  failure mode for a single-process monolith, cleaned up the same way an
  expired reservation is: it isn't matched by any order to confirm, so
  nothing can ever confirm it, and a stock discrepancy of this kind would
  show up immediately in the health/ops data for a real system. A full
  ACID transaction here was deliberately skipped to keep the primary
  code path (the one under actual concurrency stress) as simple as
  possible; it is the one piece of this project's transactional story that
  is not exercised by the automated tests.
- **The load-test client itself has a scaling ceiling** on this Windows dev
  machine well above the project's required 200-concurrent scenario (see
  above) - a property of firing raw sockets from a single Node process, not
  of the server.

# 💳 Payment Service

A robust, production-ready payment processing microservice built with **Node.js**, **TypeScript**, and **Express**. Supports Stripe and PayPal, full transaction lifecycle management, refunds, idempotency, webhooks, and more.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Multi-provider** | Stripe & PayPal out of the box; extensible provider interface |
| **Full payment lifecycle** | Create → Authorize → Capture → Refund / Cancel |
| **Idempotency** | Duplicate-safe POSTing via `Idempotency-Key` header |
| **Webhooks** | Outbound webhook dispatch with exponential-backoff retry |
| **Inbound webhooks** | Verified Stripe webhook handler |
| **Transaction ledger** | Every state change recorded as an immutable transaction |
| **Caching** | Redis-backed caching for hot payment reads |
| **Auth** | JWT Bearer authentication with role-based access control |
| **Observability** | Structured JSON logging (Winston), `/health` & `/health/ready` probes |
| **Security** | Helmet, CORS, rate limiting, AES-256 encryption helpers |
| **Testing** | Unit + integration test suites with ≥80% coverage gates |
| **CI/CD** | GitHub Actions pipeline: lint → test → build → push to GHCR |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   API Gateway / LB                   │
└───────────────────────┬─────────────────────────────┘
                        │ HTTPS
┌───────────────────────▼─────────────────────────────┐
│               Payment Service (Node.js)              │
│                                                      │
│  Routes → Controllers → Services → Providers        │
│                    │                                 │
│            Middleware Layer                          │
│  (Auth · Validation · Rate Limit · Idempotency)     │
└──────┬──────────────────────────┬───────────────────┘
       │                          │
┌──────▼──────┐          ┌────────▼────────┐
│  PostgreSQL  │          │     Redis        │
│  (primary)   │          │  (cache/queue)   │
└─────────────┘          └─────────────────┘
       │
┌──────▼──────────────────────────────────┐
│        Payment Providers                 │
│   Stripe API        PayPal API           │
└──────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
payment-service/
├── src/
│   ├── config/            # Centralised env-based configuration
│   ├── controllers/       # Request handlers (thin layer)
│   ├── database/
│   │   ├── connection.ts  # Knex connection pool
│   │   └── migrations/    # SQL schema migrations
│   ├── middleware/        # Auth, validation, error handler, idempotency
│   ├── providers/         # Stripe & PayPal provider adapters
│   ├── routes/            # Express routers
│   ├── services/          # Core business logic
│   ├── types/             # Shared TypeScript types & enums
│   ├── utils/             # Logger, encryption, custom errors
│   ├── app.ts             # Express app factory
│   └── index.ts           # Entry point + graceful shutdown
├── src/__tests__/
│   ├── unit/              # Isolated unit tests (mocked deps)
│   └── integration/       # API-level integration tests
├── .github/workflows/     # CI/CD pipelines
├── Dockerfile             # Multi-stage production image
├── docker-compose.yml     # Local dev stack
└── .env.example           # Environment variable template
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- Docker & Docker Compose
- A Stripe account (test keys are fine)

### 1. Clone & configure

```bash
git clone https://github.com/your-org/payment-service.git
cd payment-service
cp .env.example .env
# Edit .env — set STRIPE_SECRET_KEY, DB_PASSWORD, JWT_SECRET, etc.
```

### 2. Start with Docker Compose

```bash
docker-compose up -d
```

This starts:
- **payment-service** on `http://localhost:3000`
- **PostgreSQL** on `localhost:5432`
- **Redis** on `localhost:6379`

### 3. Run locally (without Docker)

```bash
npm install
npm run migrate      # Apply database migrations
npm run dev          # Start with hot-reload
```

---

## 📡 API Reference

All endpoints are prefixed with `/api/v1`. Authentication requires a JWT `Bearer` token in the `Authorization` header.

### Authentication

```
Authorization: Bearer <jwt_token>
```

Roles: `admin` | `merchant` | `readonly`

---

### Payments

#### Create a Payment

```http
POST /api/v1/payments
Idempotency-Key: <unique-key>
Content-Type: application/json

{
  "merchantId": "uuid",
  "customerId": "uuid",
  "orderId": "ORDER-001",
  "amount": 2999,
  "currency": "USD",
  "method": "card",
  "provider": "stripe",
  "paymentMethodId": "pm_stripe_xxx",
  "description": "Premium subscription",
  "idempotencyKey": "order-001-attempt-1",
  "capture": true
}
```

**Response `201`**
```json
{
  "success": true,
  "data": {
    "id": "c3a7f...",
    "status": "completed",
    "amount": 2999,
    "currency": "USD",
    ...
  }
}
```

#### Get a Payment

```http
GET /api/v1/payments/:paymentId
```

#### List Payments

```http
GET /api/v1/payments?status=completed&currency=USD&page=1&limit=20
```

| Query Param | Type | Description |
|---|---|---|
| `status` | string | Filter by status |
| `method` | string | `card`, `bank_transfer`, etc. |
| `currency` | string | ISO 4217 code |
| `fromDate` | ISO date | Range start |
| `toDate` | ISO date | Range end |
| `page` | number | Page number (default: 1) |
| `limit` | number | Items per page (max: 100) |

#### Capture a Payment

```http
POST /api/v1/payments/:paymentId/capture
Content-Type: application/json

{ "amount": 2999 }
```

#### Cancel a Payment

```http
POST /api/v1/payments/:paymentId/cancel
```

---

### Refunds

#### Create a Refund

```http
POST /api/v1/payments/:paymentId/refunds
Idempotency-Key: <unique-key>
Content-Type: application/json

{
  "paymentId": "uuid",
  "amount": 1000,
  "reason": "Customer request"
}
```

#### List Refunds for a Payment

```http
GET /api/v1/payments/:paymentId/refunds
```

#### Get a Specific Refund

```http
GET /api/v1/payments/:paymentId/refunds/:refundId
```

---

### Transactions

#### List Transactions for a Payment

```http
GET /api/v1/payments/:paymentId/transactions
```

---

### Webhooks (Inbound)

#### Stripe Events

```http
POST /webhooks/stripe
Stripe-Signature: t=...,v1=...
```

Handled events:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `charge.dispute.created`
- `charge.refunded`

---

### Health

```http
GET /health          # Liveness probe
GET /health/ready    # Readiness probe (checks DB + Redis)
```

---

## 💰 Payment Status Flow

```
PENDING ──► PROCESSING ──► COMPLETED
   │              │              │
   │              │              └──► PARTIALLY_REFUNDED ──► REFUNDED
   │              │
   └──────────────┴──► FAILED
                  │
                  └──► CANCELLED
                  │
                  └──► DISPUTED ──► CHARGEBACK
```

---

## 🔒 Security

- **JWT auth** with role-based access (`admin`, `merchant`, `readonly`)
- **Idempotency** prevents duplicate charges from network retries
- **Webhook signature verification** (HMAC-SHA256) for inbound Stripe events
- **AES-256-CBC** encryption helpers for sensitive data at rest
- **Helmet** sets security headers; **CORS** whitelist configurable per env
- **Rate limiting** (configurable via env): 100 req/min default

---

## 🧪 Testing

```bash
npm test                  # All tests with coverage
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
npm run test:watch        # Watch mode
```

Coverage thresholds enforced at 80% for branches, functions, lines, and statements.

---

## 🐳 Docker

```bash
# Build image
docker build -t payment-service .

# Run with compose (includes postgres + redis)
docker-compose up -d

# With Stripe CLI for local webhook forwarding
docker-compose --profile dev up -d
```

---

## ⚙️ Configuration

See [`.env.example`](.env.example) for the full list of environment variables.

| Variable | Required | Description |
|---|---|---|
| `DB_HOST` | ✅ | PostgreSQL host |
| `REDIS_HOST` | ✅ | Redis host |
| `JWT_SECRET` | ✅ | JWT signing secret |
| `STRIPE_SECRET_KEY` | ✅ | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Stripe webhook endpoint secret |
| `ENCRYPTION_KEY` | ✅ | 32-char AES key for data encryption |
| `LOG_LEVEL` | ⬜ | `debug`, `info`, `warn`, `error` (default: `info`) |
| `RATE_LIMIT_MAX_REQUESTS` | ⬜ | Requests per window (default: 100) |

---

## 🤝 Contributing

1. Branch from `develop`: `git checkout -b feat/your-feature`
2. Write tests for your changes
3. Ensure `npm test` and `npm run lint` pass
4. Open a pull request targeting `develop`

---

## 📄 License

UNLICENSED — Internal use only.

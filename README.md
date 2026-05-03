# Open Banking Adapter Bank

A production-ready bridge that connects a legacy core banking system (Java, Spring Boot, Mainframe, etc.) to the Open Banking Hub. It implements the consent and token flow, proxies resource requests to the internal bank API, and initiates Mojaloop payments.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
  - [OAuth2 / Consent Flow](#oauth2--consent-flow)
  - [Resource Endpoints](#resource-endpoints)
  - [Transfer Endpoints](#transfer-endpoints)
  - [Login UI](#login-ui)
- [Bank Core API Requirements](#bank-core-api-requirements)
- [Mojaloop Integration](#mojaloop-integration)

---

## Overview

```
Hub → adapter-bank → Bank Core (internal)
                   ↓
              Mojaloop SDK  (payments only)
```

The adapter sits in front of the real banking system. The Hub only ever talks to this adapter — the core bank is never exposed to external systems.

**Key capabilities:**

- RSA-256 JWT signing (keys generated at startup, public key at `/.well-known/jwks.json`)
- Login UI backed by the Bank Core `/internal/login` endpoint
- Dynamic authorisation screen: fetches user accounts from the Bank Core and renders permission + account checkboxes (PSD2-style granular consent)
- Dependency enforcement: selecting `PAYMENTS_WRITE` locks `ACCOUNTS_READ` and `TRANSACTIONS_READ` as required
- `granted_permissions` and `selected_accounts` returned in the token response so the Hub can enforce them
- Accounts and transactions proxied from the Bank Core
- `toAccountType` forwarded to the Bank Core for correct Mojaloop oracle selection (`MSISDN`, `ACCOUNT_ID`, `BUSINESS`)
- 3-step Mojaloop transfer flow (Initiate → Confirm Party → Confirm Quote)

---

## Getting Started

### Requirements

- Node.js v20+
- A running Bank Core (Spring Boot, Java, or any HTTP service)
- Optional: a running Mojaloop SDK instance for transfers

### Run locally

```bash
cd adapter-bank
npm install
cp .env.example .env   # fill in your values
npm run dev
```

Adapter listens at `http://127.0.0.1:3005` by default.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ADAPTER_PORT` | `3005` | Port this adapter listens on |
| `BANK_NAME` | `Adapter Bank` | Display name used in logs and JWT issuer |
| `BANK_CORE_URL` | — | Base URL of the internal Bank Core API (e.g. `http://localhost:8082`) |
| `HUB_CALLBACK_URL` | `http://127.0.0.1:3000/consents/callback` | Hub URL the bank redirects to after user approval |
| `SESSION_SECRET` | `adapter-secret-key` | Express session signing secret |
| `MOJALOOP_SDK_URL` | `http://127.0.0.1:5001` | Mojaloop SDK Scheme Adapter URL |

---

## API Reference

### OAuth2 / Consent Flow

The Hub registers this adapter's `authorise_url` in the bank directory. When a user creates a consent, the Hub redirects them here.

---

#### `GET /consents/authorise`

Entry point for the consent authorization flow. If the user is not logged in, redirects to `/login`.

**Query params**
| Param | Description |
|---|---|
| `consentId` | Consent UUID issued by the Hub |
| `redirect_uri` | Hub callback URL to redirect to after approval |
| `permissions` | JSON-encoded array of permissions requested by the fintech |

**Behavior:**
- If `req.session.bankUser` is **not** set → redirects to `/login?consentId=...&redirect_uri=...&permissions=...`
- If set → fetches accounts from `{BANK_CORE_URL}/internal/accounts?user={userId}` and renders a dynamic HTML page with:
  - Permission checkboxes for each requested permission (all pre-checked)
  - Account checkboxes for each account the user holds (all pre-checked)
  - JavaScript dependency rule: checking `PAYMENTS_WRITE` forces `ACCOUNTS_READ` + `TRANSACTIONS_READ` on and disables unchecking them

---

#### `POST /consents/authorise`

Called when the user submits the authorise screen.

**Form body**
| Field | Description |
|---|---|
| `consentId` | Consent UUID |
| `redirect_uri` | Hub callback URL |
| `grantedPermissions` | One or more permission values (checkbox array) |
| `selectedAccounts` | One or more account IDs (checkbox array) |

**Behavior:**
1. Generates a random authorization code
2. Stores `{ consentId, userId, grantedPermissions, selectedAccounts }` in memory keyed by the code
3. Redirects to `{redirect_uri}?code={authCode}&consentId={consentId}`

---

#### `POST /token`

Token exchange. Called by the Hub after receiving the authorization code. Invalidates the code after use.

**Request body**
```json
{ "code": "abc123" }
```

**Response `200`**
```json
{
  "access_token": "<RS256 JWT>",
  "bank_user_id": "joao",
  "granted_permissions": ["ACCOUNTS_READ", "TRANSACTIONS_READ"],
  "selected_accounts": ["acc-001"],
  "expires_in": 3600
}
```

The JWT is signed with the adapter's RSA private key. Its payload contains:
```json
{ "sub": "<bank_user_id>", "consentId": "<consent_uuid>", "iss": "<BANK_NAME>", "aud": "hub_client_001" }
```

**Error `401`**
```json
{ "error": "invalid_grant" }
```

---

#### `GET /.well-known/jwks.json`

Returns the RSA public key in JWK format. The Hub can use this to verify JWTs issued by this adapter.

**Response `200`**
```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "adapter-key-1",
      "alg": "RS256",
      "use": "sig",
      "n": "...",
      "e": "AQAB"
    }
  ]
}
```

---

### Resource Endpoints

These are called by the Hub when a fintech requests data. The Hub sends the JWT access token and the bank user ID.

---

#### `GET /accounts`

**Headers received from Hub**
```
Authorization: Bearer <JWT>
X-Consent-ID:  <consentId>
X-User-ID:     <bank_user_id>
```

**Internal request sent to Bank Core**
```
GET {BANK_CORE_URL}/internal/accounts?user={userId}
```

The `userId` is extracted from the JWT payload `sub` field.

**Response `200`** (proxied from Bank Core)
```json
{
  "accounts": [
    { "id": "acc-001", "accountName": "Checking", "balance": 5000.00, "currency": "CVE" }
  ],
  "bank": "Adapter Bank"
}
```

| Status | Reason |
|---|---|
| `502` | Bank Core unreachable |

---

#### `GET /accounts/:accountId/transactions`

**Headers received from Hub**
```
Authorization: Bearer <JWT>
X-User-ID:     <bank_user_id>
```

**Internal request sent to Bank Core**
```
GET {BANK_CORE_URL}/internal/accounts/{accountId}/transactions
```

**Response `200`** (proxied from Bank Core)
```json
{
  "transactions": [
    { "id": "tx-001", "description": "Grocery Store", "amount": -150.20, "date": "2026-04-22" }
  ]
}
```

---

### Transfer Endpoints

Implements the Mojaloop 3-step payment protocol. All endpoints require a valid Bearer token.

---

#### `POST /transfers` — Step 1: Initiate

**Headers**
```
Authorization: Bearer <JWT>
```

**Request body**
```json
{
  "amount": "1000.00",
  "currency": "CVE",
  "debtorAccount": "acc-001",
  "creditorAccount": "acc-beta-002",
  "creditorName": "Maria Souza",
  "toAccountType": "MSISDN"
}
```

| Field | Default | Description |
|---|---|---|
| `toAccountType` | `MSISDN` | Mojaloop oracle type: `MSISDN`, `ACCOUNT_ID`, or `BUSINESS` |

**Internal call to Mojaloop SDK**
```
POST {MOJALOOP_SDK_URL}/transfers
Body: { homeTransactionId, from, to, amountType, currency, amount, transactionType }
```

**Response `201`**
```json
{
  "mojaloopTransferId": "MOJALOOP-ID-123",
  "partyInfo": {
    "name": "Maria Souza",
    "account": "acc-beta-002",
    "fspId": "target-bank-fsp"
  }
}
```

---

#### `PUT /transfers/:mojaloopId/confirm-party` — Step 2: Confirm Recipient

**Internal calls to Mojaloop SDK**
1. `PUT {MOJALOOP_SDK_URL}/transfers/{mojaloopId}` with `{ acceptParty: true }`
2. Polls `GET {MOJALOOP_SDK_URL}/transfers/{mojaloopId}` until `currentState === WAITING_FOR_QUOTE_ACCEPTANCE`

**Response `200`**
```json
{
  "quoteInfo": {
    "transferAmount": { "amount": "1000.00", "currency": "CVE" },
    "payeeFspFee": { "amount": "10.00", "currency": "CVE" },
    "expiration": "2026-04-28T12:10:00.000Z"
  }
}
```

---

#### `PUT /transfers/:mojaloopId/confirm-quote` — Step 3: Execute

**Internal call to Mojaloop SDK**
```
PUT {MOJALOOP_SDK_URL}/transfers/{mojaloopId}
Body: { acceptQuote: true }
```

**Response `200`**
```json
{ "status": "COMPLETED" }
```

---

### Login UI

#### `GET /login`

Serves `public/login.html`. Form POSTs to `POST /login`.

#### `POST /login`

**Form body**
| Field | Description |
|---|---|
| `username` | Bank user username |
| `password` | Bank user password |
| `consentId` | Forwarded from the original consent redirect |
| `redirect_uri` | Hub callback URL |

**Internal call to Bank Core**
```
POST {BANK_CORE_URL}/internal/login
Body: { username, password }
```

If `auth.data.valid === true`, stores `{ id: auth.data.userId }` in session and redirects to `/consents/authorise`.

---

## Bank Core API Requirements

The adapter expects the internal Bank Core to expose these private HTTP endpoints:

### `POST /internal/login`

**Request**
```json
{ "username": "joao", "password": "secret" }
```

**Response `200` (success)**
```json
{ "valid": true, "userId": "joao" }
```

**Response `200` (failure)**
```json
{ "valid": false }
```

---

### `GET /internal/accounts?user={userId}`

**Response**
```json
[
  {
    "id": "acc-001",
    "accountName": "Checking",
    "accountType": "CURRENT",
    "balance": 5000.00,
    "currency": "CVE",
    "msisdn": "23000000010",
    "partyType": "CONSUMER",
    "businessId": null
  }
]
```

> `msisdn`, `partyType`, and `businessId` are required for correct Mojaloop party lookup. `partyType` is `"CONSUMER"` for personal accounts and `"BUSINESS"` for business accounts.

---

### `GET /internal/accounts/{accountId}/transactions`

**Response**
```json
[
  { "id": "tx-001", "description": "Salary", "amount": 3500.00, "date": "2026-04-20" }
]
```

---

## Mojaloop Integration

The `MojaloopService` (`src/services/mojaloopService.js`) handles all communication with the Mojaloop SDK Scheme Adapter.

**Transfer state machine:**
```
POST /transfers → initiateTransfer()
                      ↓ POST {MOJALOOP_SDK_URL}/transfers
                      ← { transferId, to.displayName }

PUT /confirm-party → confirmParty()
                      ↓ PUT {MOJALOOP_SDK_URL}/transfers/{id} { acceptParty: true }
                      ↓ polls GET /transfers/{id} until WAITING_FOR_QUOTE_ACCEPTANCE
                      ← { quoteInfo }

PUT /confirm-quote → confirmQuote()
                      ↓ PUT {MOJALOOP_SDK_URL}/transfers/{id} { acceptQuote: true }
                      ← { status: "COMPLETED" | "FAILED" }
```

The polling in step 2 retries up to 10 times with 300 ms intervals before throwing.

---

## License

Apache-2.0

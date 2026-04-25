# Open Banking Adapter 🛡️🏦

The **Open Banking Adapter** is a secure, neutral, and production-ready bridge designed to connect legacy core banking systems (Java, C#, Mainframe, etc.) to a standardized Open Banking Hub ecosystem.

It implements the **Security-First Adapter Pattern**, ensuring that your core banking logic remains isolated while providing a FAPI-compliant interface (OIDC/OAuth2 style) to the external world.

## Key Features

- **RSA Security**: Real JWT signing using RSA-256 asymmetric keys.
- **JWKS Endpoint**: Exposes public keys at `/.well-known/jwks.json` for automatic signature validation by the Hub.
- **Neutral UI**: Modern, clean, and institution-agnostic Login and Authorisation screens.
- **Resource Proxying**: Transparently maps Open Banking resource requests (Accounts, Transactions) to the internal Bank Core API.
- **Stateless & Containerized**: Easy to scale and deploy via Docker.

## Quick Start

### 1. Install Dependencies
```bash
cd adapter-bank
npm install
```

### 2. Configure Environment
Create a `.env` file based on `.env.example`:
```env
ADAPTER_PORT=3005
BANK_NAME=Adapter Bank (Open Source)
BANK_CORE_URL=http://localhost:8082
HUB_CALLBACK_URL=http://127.0.0.1:3000/consents/callback
SESSION_SECRET=your-very-secure-secret
```

### 3. Run the Adapter
```bash
npm start
```

## Internal API Requirements (The Bank's Task)

To integrate this adapter, the internal core banking system must expose the following private endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/internal/login` | POST | Receives `{username, password}`. Returns `{valid: true, userId: "1"}`. |
| `/internal/accounts` | GET | Query param `user`. Returns a JSON array of accounts. |
| `/internal/accounts/{id}/transactions` | GET | Returns a JSON array of transaction history for the account. |

## Connectivity & Networking Tips 🌐

When running in a local development environment with Docker, keep these tips in mind:

- **Inside Docker to Host machine**: If the Adapter is in Docker but your Bank Core is running locally (e.g., Spring Boot), use `http://host.docker.internal:PORT` instead of `localhost`.
- **IPv6 Issues**: Some versions of Node.js prefer IPv6 (`::1`). If connection fails, use the explicit IPv4 address `127.0.0.1` in your configurations.
- **Shared Networks**: For production-like testing, create a shared Docker network and use container names as hostnames (e.g., `http://core-bank-api:8082`).

## Docker Deployment

```bash
docker compose up -d --build
```

## License
Apache-2.0

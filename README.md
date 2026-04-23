# Open Banking Adapter 🛡️🏦

The **Open Banking Adapter** is a standalone bridge service designed to connect legacy or multi-language core banking systems (Java, C#, Mainframe, etc.) to the Open Banking Hub.

It follows the **Adapter Pattern** (similar to Mojaloop's Scheme Adapter) to ensure that the core banking code remains untouched while providing a fully compliant Open Banking interface.

## Architecture

1.  **Facing the Hub**: The adapter implements the standardized Open Banking API (OAuth2, JWS, Resource endpoints).
2.  **Facing the Bank Core**: The adapter communicates with the bank's internal system via simple, private REST/JSON endpoints.

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
BANK_CORE_URL=http://your-internal-bank-api.com
BANK_NAME=Your Bank Name
HUB_CALLBACK_URL=http://hub-url.com/consents/callback
```

### 3. Run the Adapter
```bash
npm start
```

## Integration (The Bank's Task)

To use this adapter, your internal team only needs to expose two simple endpoints in your core system:

- **POST `/internal/login`**: Should receive `{username, password}` and return `{valid: true}` if credentials are correct.
- **GET `/internal/accounts?user=:userId`**: Should return a JSON array of accounts belonging to that user.

## Docker Deployment

The adapter is containerized for easy deployment:
```bash
docker build -t Open Banking-ob-adapter .
docker run -p 3005:3005 --env-file .env Open Banking-ob-adapter
```

## License
Apache-2.0

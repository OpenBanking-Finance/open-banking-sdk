import express from 'express';
import session from 'express-session';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration
dotenv.config();
const PORT = process.env.ADAPTER_PORT || 3005;
const BANK_CORE_URL = process.env.BANK_CORE_URL; // The legacy Java/Mainframe API
const HUB_CALLBACK_URL = process.env.HUB_CALLBACK_URL || 'http://127.0.0.1:3000/consents/callback';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'adapter-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, sameSite: 'lax' }
}));

let privateKey;
let publicKey;
let jwk;

async function initKeys() {
    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
    jwk = await exportJWK(publicKey);
    jwk.kid = 'adapter-key-1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    console.log('Adapter RSA keys generated successfully.');
}
initKeys().catch(console.error);

const codes = new Map();

/**
 * OPEN BANKING PUBLIC ENDPOINTS (Standardized)
 */

app.get('/.well-known/jwks.json', (req, res) => {
    if (!jwk) return res.status(503).json({ error: 'Keys not ready' });
    res.json({ keys: [jwk] });
});

const PERMISSION_LABELS = {
    ACCOUNTS_READ:      { label: 'Account balance and details',    icon: '🏦' },
    TRANSACTIONS_READ:  { label: 'Transaction history',             icon: '📋' },
    PAYMENTS_WRITE:     { label: 'Payment and transfer initiation', icon: '💸' }
};

// 1. Authorisation Redirect — renders account + permission selection screen
app.get('/consents/authorise', async (req, res) => {
    const { consentId, redirect_uri, permissions: permissionsParam } = req.query;

    if (!req.session.bankUser) {
        return res.redirect(`/login?consentId=${consentId}&redirect_uri=${encodeURIComponent(redirect_uri)}&permissions=${encodeURIComponent(permissionsParam || '')}`);
    }

    // Parse requested permissions
    let requestedPermissions = [];
    try {
        requestedPermissions = permissionsParam ? JSON.parse(decodeURIComponent(permissionsParam)) : [];
    } catch { requestedPermissions = []; }

    // Fetch accounts from bank core
    let accounts = [];
    try {
        const response = await axios.get(`${BANK_CORE_URL}/internal/accounts?user=${req.session.bankUser.id}`);
        accounts = Array.isArray(response.data) ? response.data : [];
    } catch (err) {
        console.warn('[Adapter] Could not fetch accounts for consent screen:', err.message);
    }

    // Build permission checkboxes
    const permissionRows = requestedPermissions.map(perm => {
        const info = PERMISSION_LABELS[perm] || { label: perm, icon: '🔑' };
        const deps = perm === 'PAYMENTS_WRITE' ? 'data-requires="ACCOUNTS_READ,TRANSACTIONS_READ"' : '';
        const requiredBy = (perm === 'ACCOUNTS_READ' || perm === 'TRANSACTIONS_READ') ? `data-required-by="PAYMENTS_WRITE"` : '';
        return `
        <label class="perm-row" id="perm-row-${perm}">
          <input type="checkbox" name="grantedPermissions" value="${perm}" id="perm-${perm}" checked ${deps} ${requiredBy}>
          <span class="perm-icon">${info.icon}</span>
          <span class="perm-label">${info.label}</span>
        </label>`;
    }).join('');

    // Build account checkboxes
    const accountRows = accounts.map(acc => `
        <label class="acc-row">
          <input type="checkbox" name="selectedAccounts" value="${acc.id}" checked>
          <span class="acc-name">${acc.accountName || acc.id}</span>
          <span class="acc-meta">${acc.accountType || ''} · ${acc.balance ?? ''} ${acc.currency || ''}</span>
        </label>`).join('');

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize Access — ${process.env.BANK_NAME || 'Bank'}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:Arial,sans-serif;background:#f4f7f6;display:flex;justify-content:center;align-items:flex-start;min-height:100vh;margin:0;padding:2rem 1rem}
    .card{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);width:100%;max-width:440px}
    h2{color:#005A9C;margin:0 0 .25rem}
    .bank-name{color:#005A9C;font-size:.85rem;margin-bottom:.5rem;font-weight:normal}
    .subtitle{color:#666;font-size:.9rem;margin-bottom:1.5rem;border-bottom:1px solid #eee;padding-bottom:1rem}
    .section-title{font-weight:bold;font-size:.8rem;color:#555;text-transform:uppercase;letter-spacing:.06em;margin:1rem 0 .5rem}
    /* Permission rows */
    .perm-row{display:flex;align-items:center;gap:.75rem;padding:.65rem .5rem;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:.4rem;cursor:pointer;transition:background .15s}
    .perm-row:hover{background:#f5f8ff}
    .perm-row input{flex-shrink:0;width:17px;height:17px;cursor:pointer;accent-color:#005A9C}
    .perm-icon{font-size:1.1rem}
    .perm-label{font-size:.9rem;color:#222;flex:1}
    .perm-row.disabled{opacity:.45;pointer-events:none}
    /* Account rows */
    .acc-row{display:flex;align-items:center;gap:.75rem;padding:.6rem .5rem;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:.4rem;cursor:pointer;transition:background .15s}
    .acc-row:hover{background:#f5f8ff}
    .acc-row input{flex-shrink:0;width:17px;height:17px;cursor:pointer;accent-color:#005A9C}
    .acc-name{flex:1;font-size:.9rem;color:#222}
    .acc-meta{font-size:.78rem;color:#888}
    .hint{font-size:.78rem;color:#e67e00;margin:.25rem 0 .5rem .5rem}
    /* Buttons */
    .actions{margin-top:1.5rem;display:flex;flex-direction:column;gap:.5rem}
    .btn{width:100%;padding:12px;border:none;border-radius:6px;cursor:pointer;font-size:.95rem;font-weight:600}
    .btn-approve{background:#005A9C;color:#fff}
    .btn-approve:hover{background:#004a82}
    .btn-deny{background:#fff;color:#dc3545;border:1.5px solid #dc3545}
    .btn-deny:hover{background:#fff5f5}
  </style>
</head>
<body>
  <div class="card">
    <h2>Access Authorization</h2>
    <p class="bank-name">${process.env.BANK_NAME || 'Bank'}</p>
    <p class="subtitle">A third-party application is requesting access to your account. Select what you want to share.</p>

    <form action="/consents/authorise" method="POST" id="authForm">
      <input type="hidden" name="consentId" value="${consentId || ''}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">

      ${requestedPermissions.length > 0 ? `
      <p class="section-title">Requested Permissions</p>
      ${permissionRows}
      <p class="hint" id="payments-hint" style="display:none">⚠️ Payments require access to account balance and transaction history</p>
      ` : ''}

      ${accounts.length > 0 ? `
      <p class="section-title">Accounts to share</p>
      ${accountRows}
      ` : ''}

      <div class="actions">
        <button type="submit" class="btn btn-approve">Confirm & Authorize</button>
      </div>
    </form>
    <div class="actions">
      <button class="btn btn-deny" onclick="deny()">Deny Access</button>
    </div>
  </div>

  <script>
    // Dependency: PAYMENTS_WRITE requires ACCOUNTS_READ + TRANSACTIONS_READ
    const paymentsBox = document.getElementById('perm-PAYMENTS_WRITE');
    const accountsBox = document.getElementById('perm-ACCOUNTS_READ');
    const txBox       = document.getElementById('perm-TRANSACTIONS_READ');
    const hint        = document.getElementById('payments-hint');

    function enforceDeps() {
      if (!paymentsBox) return;
      if (paymentsBox.checked) {
        // Force dependencies on
        if (accountsBox) { accountsBox.checked = true; accountsBox.disabled = true; }
        if (txBox)       { txBox.checked = true;       txBox.disabled = true;       }
        if (hint) hint.style.display = 'block';
      } else {
        if (accountsBox) accountsBox.disabled = false;
        if (txBox)       txBox.disabled = false;
        if (hint) hint.style.display = 'none';
      }
    }

    if (paymentsBox) paymentsBox.addEventListener('change', enforceDeps);
    // If the user unchecks accounts/transactions while payments is off — no restriction
    enforceDeps(); // apply on load in case checkboxes start checked

    function deny() {
      const redirectUri = '${redirect_uri || ''}' || 'http://127.0.0.1:3000/consents/callback';
      const consentId = '${consentId || ''}';
      window.location.href = redirectUri + '?consentId=' + consentId + '&status=REJECTED';
    }
  </script>
</body>
</html>`);
});

// 2. Handle Approval — stores selected accounts and granted permissions alongside the auth code
app.post('/consents/authorise', (req, res) => {
    const { consentId, redirect_uri } = req.body;

    // Checkboxes may come as a single string or array
    const rawAccounts = req.body.selectedAccounts;
    const selectedAccounts = rawAccounts ? (Array.isArray(rawAccounts) ? rawAccounts : [rawAccounts]) : [];

    const rawPerms = req.body.grantedPermissions;
    const grantedPermissions = rawPerms ? (Array.isArray(rawPerms) ? rawPerms : [rawPerms]) : [];

    const authCode = Math.random().toString(36).substring(7);
    codes.set(authCode, { consentId, userId: req.session.bankUser.id, selectedAccounts, grantedPermissions });

    console.log(`[Adapter] Consent approved. code=${authCode} permissions=${grantedPermissions} accounts=${selectedAccounts}`);
    res.redirect(`${redirect_uri || HUB_CALLBACK_URL}?code=${authCode}&consentId=${consentId}`);
});

// 3. Token Exchange — includes selected_accounts in response so Hub can persist them
app.post('/token', async (req, res) => {
    const { code } = req.body;
    const data = codes.get(code);
    if (!data) return res.status(401).json({ error: 'invalid_grant' });

    try {
        console.log(`[Adapter] Exchanging auth_code for token. Code: ${code}`);
        const jwt = await new SignJWT({ sub: data.userId, consentId: data.consentId })
            .setProtectedHeader({ alg: 'RS256', kid: 'adapter-key-1' })
            .setIssuedAt()
            .setIssuer(process.env.BANK_NAME || 'Adapter Bank')
            .setAudience('hub_client_001')
            .setExpirationTime('1h')
            .sign(privateKey);

        codes.delete(code);
        console.log(`[Adapter] JWT signed successfully for user: ${data.userId}`);
        res.json({
            access_token: jwt,
            bank_user_id: data.userId,
            selected_accounts: data.selectedAccounts || [],
            granted_permissions: data.grantedPermissions || [],
            expires_in: 3600
        });
    } catch (err) {
        console.error(`[Adapter] Token generation error:`, err.message);
        res.status(500).json({ error: 'token_generation_failed' });
    }
});

/**
 * RESOURCE ENDPOINTS (Proxy to Bank Core)
 */

app.get('/accounts', async (req, res) => {
    let userId = 'anonymous';
    
    // Extract userId from JWT Token sent by the Hub
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const { jwtVerify } = await import('jose');
            const { payload } = await jwtVerify(token, publicKey);
            userId = payload.sub;
            console.log(`[Adapter] Requesting accounts for user from JWT: ${userId}`);
        } catch (err) {
            console.warn('[Adapter] Invalid JWT token received in /accounts');
        }
    }

    try {
        console.log(`[Adapter] Calling Core Bank: ${BANK_CORE_URL}/internal/accounts?user=${userId}`);
        const response = await axios.get(`${BANK_CORE_URL}/internal/accounts?user=${userId}`);
        res.json({ accounts: response.data, bank: process.env.BANK_NAME || 'Adapter Bank' });
    } catch (err) {
        console.error(`[Adapter] Core Bank communication failed for user ${userId}:`, err.message);
        res.status(502).json({ error: 'Core Bank communication failed' });
    }
});

// RESOURCE: Real Transactions Route (Proxying to Core Bank)
app.get('/accounts/:accountId/transactions', async (req, res) => {
    const { accountId } = req.params;
    console.log(`[Adapter] Fetching real transactions for account: ${accountId} from Core Bank`);
    
    try {
        const response = await axios.get(`${BANK_CORE_URL}/internal/accounts/${accountId}/transactions`);
        console.log(`[Adapter] Core Bank returned ${response.data.length} transactions for ${accountId}`);
        res.json({ transactions: response.data });
    } catch (err) {
        console.error(`[Adapter] Failed to fetch transactions for ${accountId}:`, err.message);
        res.status(502).json({ error: 'Core Bank communication failed' });
    }
});

/**
 * TRANSFER ENDPOINTS (Mojaloop 3-Step Flow)
 */

// Helper: extracts and validates the Bearer token from the request
function extractBearer(req, res) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Bearer token' });
        return null;
    }
    return auth.split(' ')[1];
}

// Step 1 — Initiate transfer (delegates to Bank Core → Mojaloop SDK)
app.post('/transfers', async (req, res) => {
    const token = extractBearer(req, res);
    if (!token) return;

    const { amount, currency, debtorAccount, creditorAccount, creditorName, toAccountType } = req.body;
    if (!amount || !creditorAccount || !creditorName) {
        return res.status(400).json({ error: 'amount, creditorAccount and creditorName are required' });
    }

    try {
        const { data } = await axios.post(`${BANK_CORE_URL}/transfer`, {
            fromAccount: debtorAccount,
            toAccount: creditorAccount,
            toAccountType: toAccountType || 'MSISDN',
            currency,
            amount: String(amount)
        }, { headers: { Authorization: `Bearer ${token}` } });

        console.log(`[Adapter] Transfer initiated → mojaloopId: ${data.transferId}`);
        res.status(201).json({
            mojaloopTransferId: data.transferId,
            partyInfo: { name: data.party.name, account: data.party.account, fspId: data.party.fspId }
        });
    } catch (err) {
        console.error('[Adapter] initiateTransfer failed:', err.message);
        res.status(err.response?.status || 502).json({ error: 'Bank Core communication failed', detail: err.message });
    }
});

// Step 2 — Confirm recipient and retrieve quote
app.put('/transfers/:mojaloopId/confirm-party', async (req, res) => {
    const token = extractBearer(req, res);
    if (!token) return;

    const { mojaloopId } = req.params;

    try {
        const { data } = await axios.put(`${BANK_CORE_URL}/transfer/${mojaloopId}/confirm-party`,
            {}, { headers: { Authorization: `Bearer ${token}` } });

        console.log(`[Adapter] Party confirmed for ${mojaloopId}`);
        res.json({
            quoteInfo: {
                transferAmount: { amount: data.quote.transferAmount, currency: data.quote.currency },
                payeeFspFee:    { amount: data.quote.fee,            currency: data.quote.currency },
                expiration:     data.quote.expiration
            }
        });
    } catch (err) {
        console.error('[Adapter] confirmParty failed:', err.message);
        res.status(err.response?.status || 502).json({ error: 'Bank Core communication failed', detail: err.message });
    }
});

// Step 3 — Confirm quote and execute transfer
app.put('/transfers/:mojaloopId/confirm-quote', async (req, res) => {
    const token = extractBearer(req, res);
    if (!token) return;

    const { mojaloopId } = req.params;

    try {
        const { data } = await axios.put(`${BANK_CORE_URL}/transfer/${mojaloopId}/confirm-quote`,
            {}, { headers: { Authorization: `Bearer ${token}` } });

        const status = data.status === 'COMMITTED' ? 'COMPLETED' : 'FAILED';
        console.log(`[Adapter] Quote confirmed for ${mojaloopId} → ${status}`);
        res.json({ status });
    } catch (err) {
        console.error('[Adapter] confirmQuote failed:', err.message);
        res.status(err.response?.status || 502).json({ error: 'Bank Core communication failed', detail: err.message });
    }
});

/**
 * LOGIN UI (Handled by Adapter to protect the Core)
 */
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password, redirect_uri, consentId, permissions } = req.body;
    console.log(`[Adapter] Login attempt for user: ${username} at ${BANK_CORE_URL}`);

    try {
        // Validate credentials against the Bank Core
        const auth = await axios.post(`${BANK_CORE_URL}/internal/login`, { username, password });
        console.log(`[Adapter] Core Bank response:`, auth.data);

        if (auth.data.valid) {
            console.log(`[Adapter] Login successful for: ${username} (ID: ${auth.data.userId})`);
            req.session.bankUser = { id: auth.data.userId };
            const permParam = permissions ? `&permissions=${encodeURIComponent(permissions)}` : '';
            return res.redirect(`/consents/authorise?consentId=${consentId}&redirect_uri=${encodeURIComponent(redirect_uri)}${permParam}`);
        } else {
            console.warn(`[Adapter] Login failed: Invalid credentials for ${username}`);
        }
    } catch (err) {
        console.error(`[Adapter] Core Bank connection error:`, err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error(`[Adapter] ERROR: Could not connect to Core Bank at ${BANK_CORE_URL}. Is the Spring Boot app running?`);
        }
    }

    res.redirect('/login?error=Invalid credentials');
});

app.listen(PORT, () => {
    console.log(`Open Banking OB Adapter active for [${process.env.BANK_NAME}] on port ${PORT}`);
    console.log(`Bridging to Bank Core: ${BANK_CORE_URL}`);
});

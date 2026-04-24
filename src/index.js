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

// 1. Authorisation Redirect
app.get('/consents/authorise', (req, res) => {
    const { consentId, redirect_uri } = req.query;
    
    // Check if bank user is logged in the adapter session
    if (!req.session.bankUser) {
        return res.redirect(`/login?consentId=${consentId}&redirect_uri=${encodeURIComponent(redirect_uri)}`);
    }
    
    // Serve the approval screen (The adapter has its own UI or points to the bank's)
    res.sendFile(path.join(__dirname, '../public/authorise.html'));
});

// 2. Handle Approval
app.post('/consents/authorise', (req, res) => {
    const { consentId, redirect_uri } = req.body;
    const authCode = Math.random().toString(36).substring(7);
    
    codes.set(authCode, { consentId, userId: req.session.bankUser.id });
    res.redirect(`${redirect_uri || HUB_CALLBACK_URL}?code=${authCode}&consentId=${consentId}`);
});

// 3. Token Exchange
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

        console.log(`[Adapter] JWT signed successfully for user: ${data.userId}`);
        res.json({
            access_token: jwt,
            bank_user_id: data.userId,
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
 * LOGIN UI (Handled by Adapter to protect the Core)
 */
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.post('/login', async (req, res) => {
    const { username, password, redirect_uri, consentId } = req.body;
    console.log(`[Adapter] Login attempt for user: ${username} at ${BANK_CORE_URL}`);
    
    try {
        // Validate credentials against the Bank Core
        const auth = await axios.post(`${BANK_CORE_URL}/internal/login`, { username, password });
        console.log(`[Adapter] Core Bank response:`, auth.data);

        if (auth.data.valid) {
            console.log(`[Adapter] Login successful for: ${username} (ID: ${auth.data.userId})`);
            req.session.bankUser = { id: auth.data.userId };
            return res.redirect(`/consents/authorise?consentId=${consentId}&redirect_uri=${encodeURIComponent(redirect_uri)}`);
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

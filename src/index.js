import express from 'express';
import session from 'express-session';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

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

const codes = new Map();

/**
 * OPEN BANKING PUBLIC ENDPOINTS (Standardized)
 */

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
app.post('/token', (req, res) => {
    const { code } = req.body;
    const data = codes.get(code);
    if (!data) return res.status(401).json({ error: 'invalid_grant' });

    res.json({
        access_token: `at_adapter_${Math.random().toString(36).substring(7)}`,
        bank_user_id: data.userId,
        expires_in: 3600
    });
});

/**
 * RESOURCE ENDPOINTS (Proxy to Bank Core)
 */

app.get('/accounts', async (req, res) => {
    const userId = req.headers['x-user-id'] || 'anonymous';
    try {
        // The Adapter translates the complex OB request into a simple Core Bank request
        const response = await axios.get(`${BANK_CORE_URL}/internal/accounts?user=${userId}`);
        res.json({ accounts: response.data, bank: process.env.BANK_NAME || 'Adapter Bank' });
    } catch (err) {
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
    
    try {
        // Validate credentials against the Bank Core
        const auth = await axios.post(`${BANK_CORE_URL}/internal/login`, { username, password });
        if (auth.data.valid) {
            req.session.bankUser = { id: username };
            return res.redirect(`/consents/authorise?consentId=${consentId}&redirect_uri=${encodeURIComponent(redirect_uri)}`);
        }
    } catch (err) {}
    
    res.redirect('/login?error=Invalid credentials');
});

app.listen(PORT, () => {
    console.log(`Open Banking OB Adapter active for [${process.env.BANK_NAME}] on port ${PORT}`);
    console.log(`Bridging to Bank Core: ${BANK_CORE_URL}`);
});

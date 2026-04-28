// src/services/cbClient.js
// Talks to the Clearing Bank API at CB_BASE_URL.
// Verified against https://stevenop.be/pingfin/api/v2/help (April 2026).
//
// Endpoint paths (NO trailing slash, confirmed from docs):
//   POST /token       - body { bic, secret_key }      -> { ok, status, token }
//   GET  /banks       - bearer auth                   -> { ok, status, data: [...] }
//   POST /banks       - bearer auth, body { name, members }
//   POST /po_in       - bearer auth, body { data: [PO,...] }
//   GET  /po_out      - bearer auth   *** DESTRUCTIVE: items are removed from queue!
//   GET  /po_out/test/true - bearer auth, READ-ONLY (no delete, no log)
//   POST /ack_in      - bearer auth, body { data: [ACK,...] }
//   GET  /ack_out     - bearer auth   *** DESTRUCTIVE
//   GET  /ack_out/test/true - bearer auth, READ-ONLY
//   GET  /errorcodes  - public                        -> full error code list
//   GET  /stats/type/log - bearer auth, GLOBAL log of all teams
//
// Token validity: 4 hours (cached in cb_tokens table).
// Auth header: Authorization: Bearer <token>

const { query } = require('../db/pool');
const { cbBaseUrl, banks } = require('../config');
const { log, LOG_TYPES } = require('./logger');

const TOKEN_ENDPOINT = '/token';

// ---------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------
async function getCachedToken(bankBic) {
    const r = await query(
        `SELECT token, expires_at FROM cb_tokens
          WHERE bank_id = $1
            AND expires_at > NOW() + INTERVAL '60 seconds'`,
        [bankBic]
    );
    return r.rowCount > 0 ? r.rows[0].token : null;
}

async function storeToken(bankBic, token, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await query(
        `INSERT INTO cb_tokens (bank_id, token, expires_at, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (bank_id) DO UPDATE
           SET token      = EXCLUDED.token,
               expires_at = EXCLUDED.expires_at,
               updated_at = NOW()`,
        [bankBic, token, expiresAt]
    );
}

// ---------------------------------------------------------------
// Token generation
// CB response shape: { ok: true, status: 200, token: "ivzS..." }
// ---------------------------------------------------------------
async function generateToken(bankBic) {
    const bank = banks.find(b => b.bic === bankBic);
    if (!bank) throw new Error(`Unknown bank ${bankBic}`);

    const url = `${cbBaseUrl}${TOKEN_ENDPOINT}`;
    const body = { bic: bank.bic, secret_key: bank.secret };

    await log(bankBic, LOG_TYPES.API_OUT, `POST ${url} (token request)`);

    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    if (!resp.ok || !parsed.ok) {
        const msg = parsed.message || parsed.error || `HTTP ${resp.status}`;
        await log(bankBic, LOG_TYPES.EXCEPTION, `Token request failed: ${msg}`);
        throw new Error(`CB token request failed: ${msg}`);
    }

    // Verified: token is in root, not in data
    const token = parsed.token;
    if (!token || typeof token !== 'string') {
        await log(bankBic, LOG_TYPES.EXCEPTION, `Token missing from CB response: ${text.substring(0, 200)}`);
        throw new Error('CB response did not contain a token field');
    }

    // 4 hours per docs. Cache slightly less to be safe (3h55m).
    const ttl = (4 * 60 * 60) - 300;
    await storeToken(bankBic, token, ttl);
    await log(bankBic, LOG_TYPES.AUTH, `Token cached (~4h)`);
    return token;
}

async function getToken(bankBic) {
    const cached = await getCachedToken(bankBic);
    if (cached) return cached;
    return generateToken(bankBic);
}

// ---------------------------------------------------------------
// Generic authenticated CB request
// Auto-refreshes token on 401 once.
// ---------------------------------------------------------------
async function cbRequest(bankBic, { method, path, body = null, retryOn401 = true }) {
    let token = await getToken(bankBic);
    const url = `${cbBaseUrl}${path}`;

    await log(bankBic, LOG_TYPES.API_OUT, `${method} ${url}`);

    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
        },
    };
    if (body != null) opts.body = JSON.stringify(body);

    let resp = await fetch(url, opts);
    let text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    // Handle expired/invalid token: refresh once and retry
    if (resp.status === 401 && retryOn401) {
        await log(bankBic, LOG_TYPES.AUTH, `Got 401 - refreshing token and retrying`);
        token = await generateToken(bankBic);
        opts.headers.Authorization = `Bearer ${token}`;
        resp = await fetch(url, opts);
        text = await resp.text();
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    }

    if (!resp.ok) {
        const errMsg = parsed.message || parsed.error || `HTTP ${resp.status}`;
        await log(bankBic, LOG_TYPES.EXCEPTION, `CB ${method} ${path} -> ${errMsg}`);
    }

    return { status: resp.status, ok: resp.ok, body: parsed };
}

// ---------------------------------------------------------------
// Endpoint wrappers (verified paths, no trailing slash)
// ---------------------------------------------------------------

// GET /banks - list all registered banks
async function cbListBanks(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/banks' });
}

// POST /banks - update OUR bank's display info
async function cbUpdateBank(bankBic, { name, members }) {
    return cbRequest(bankBic, {
        method: 'POST',
        path: '/banks',
        body: { name, members },
    });
}

// POST /po_in - send PO's to the CB (we are OB)
async function cbPostPoIn(bankBic, pos) {
    return cbRequest(bankBic, { method: 'POST', path: '/po_in', body: { data: pos } });
}

// GET /po_out - fetch PO's where we are BB.
// IMPORTANT: this is DESTRUCTIVE - items are removed from CB queue.
// Use cbPeekPoOut() for read-only debugging.
async function cbConsumePoOut(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/po_out' });
}

// GET /po_out/test/true - read-only preview, no delete, no log
async function cbPeekPoOut(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/po_out/test/true' });
}

// POST /ack_in - send ACK's to CB (we are BB confirming a payment)
async function cbPostAckIn(bankBic, acks) {
    return cbRequest(bankBic, { method: 'POST', path: '/ack_in', body: { data: acks } });
}

// GET /ack_out - fetch ACK's for PO's we sent (we are OB).
// DESTRUCTIVE - items are removed from CB queue.
async function cbConsumeAckOut(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/ack_out' });
}

// GET /ack_out/test/true - read-only preview
async function cbPeekAckOut(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/ack_out/test/true' });
}

// GET /errorcodes - public, no auth needed
async function cbErrorCodes() {
    const url = `${cbBaseUrl}/errorcodes`;
    const resp = await fetch(url);
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: resp.status, ok: resp.ok, body: parsed };
}

// GET /stats/type/log - global log across ALL teams (useful for debugging)
async function cbGlobalLog(bankBic) {
    return cbRequest(bankBic, { method: 'GET', path: '/stats/type/log' });
}

module.exports = {
    getToken,
    generateToken,
    cbRequest,
    // High-level endpoint wrappers
    cbListBanks,
    cbUpdateBank,
    cbPostPoIn,
    cbConsumePoOut,
    cbPeekPoOut,
    cbPostAckIn,
    cbConsumeAckOut,
    cbPeekAckOut,
    cbErrorCodes,
    cbGlobalLog,
};

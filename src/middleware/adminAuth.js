// src/middleware/adminAuth.js
// Admin bearer-token check for our internal endpoints (used later by GUI).
// Tokens come from ADMIN_TOKENS env var (comma separated).

const { adminTokens } = require('../config');
const { fail } = require('../utils/response');
const { OWN } = require('../utils/errorCodes');

function adminAuth(req, res, next) {
    if (adminTokens.length === 0) {
        return fail(res, { status: 401, code: OWN.AUTH_MISSING, message: 'admin auth not configured' });
    }

    const auth = req.header('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
        return fail(res, { status: 401, code: OWN.AUTH_MISSING, message: 'missing or malformed Authorization header' });
    }

    const token = m[1].trim();
    if (!adminTokens.includes(token)) {
        return fail(res, { status: 401, code: OWN.AUTH_INVALID, message: 'invalid admin token' });
    }

    next();
}

module.exports = { adminAuth };

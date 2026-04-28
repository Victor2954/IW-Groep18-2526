// src/utils/response.js
// Standard response shape per slide 22:
//   { ok, status, code, message, data }
// We use the official CB code 2000 for OK, and our own codes (4100+) for errors.

const { CB, OWN } = require('./errorCodes');

function ok(res, data = null, message = null, code = CB.OK, status = 200) {
    return res.status(status).json({
        ok: true,
        status,
        code,
        message,
        data,
    });
}

function fail(res, { status = 400, code = OWN.VALIDATION_FAILED, message = 'error', data = null } = {}) {
    return res.status(status).json({
        ok: false,
        status,
        code,
        message,
        data,
    });
}

module.exports = { ok, fail };

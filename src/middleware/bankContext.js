// src/middleware/bankContext.js
// Determines which of our 2 banks an incoming request operates on.
//
// Resolution order:
//   1) X-Bank-BIC header
//   2) ?bank=BIC query param
//   3) error if missing
//
// Public endpoints like /help don't need this. Mount selectively.

const { isOurBank, banks } = require('../config');
const { fail } = require('../utils/response');
const { OWN } = require('../utils/errorCodes');

function bankContext(req, res, next) {
    const bic =
        req.header('X-Bank-BIC') ||
        req.query.bank ||
        null;

    if (!bic) {
        return fail(res, {
            status: 400,
            code: OWN.VALIDATION_FAILED,
            message: `Missing bank context. Provide X-Bank-BIC header or ?bank=<BIC>. Allowed: ${banks.map(b => b.bic).join(', ')}`,
        });
    }

    if (!isOurBank(bic)) {
        return fail(res, {
            status: 400,
            code: OWN.VALIDATION_FAILED,
            message: `Unknown bank: ${bic}. Allowed: ${banks.map(b => b.bic).join(', ')}`,
        });
    }

    req.bankBic = bic;
    next();
}

module.exports = { bankContext };

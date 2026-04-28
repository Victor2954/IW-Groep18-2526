// src/utils/validate.js
// Per slides 14-15 business rules + verified CB error codes.

const { CB, OWN } = require('./errorCodes');

// BIC: 8 or 11 chars, all uppercase letters/digits, no spaces.
// Slide 15: "each bank id should be a valid BIC (no spaces)"
function isValidBic(bic) {
    if (typeof bic !== 'string') return false;
    return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic);
}

// IBAN: 2 letter country + 2 check digits + up to 30 alphanum, no spaces.
// Slide 15: "each account id should be a valid IBAN code (no spaces)"
function isValidIban(iban) {
    if (typeof iban !== 'string') return false;
    if (/\s/.test(iban)) return false;
    return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(iban);
}

// Amount: positive, max 500, max 2 decimals.
// Slides 14-15: "max 500 euros", "no more than two digits after the comma"
const MAX_PO_AMOUNT = 500;

function isValidAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return false;
    if (n <= 0) return false;
    if (n > MAX_PO_AMOUNT) return false;
    // 2-decimal check: round to 2, compare
    return Math.round(n * 100) === n * 100;
}

// Datetime in YYYY-MM-DD HH:MM:SS format (slide 15)
// Also accepts JS Date objects (which is what node-postgres returns
// for TIMESTAMP columns). When a Date object is given, we re-format it
// before checking the regex.
function isValidDatetime(s) {
    // pg returns Date objects for TIMESTAMP columns
    if (s instanceof Date) {
        return !isNaN(s.getTime());
    }
    if (typeof s !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return false;
    const d = new Date(s.replace(' ', 'T') + 'Z');
    return !isNaN(d.getTime());
}

// PO id: prefixed with BIC_, max 50 chars (slide 15)
function isValidPoId(poId, expectedObBic) {
    if (typeof poId !== 'string') return false;
    if (poId.length > 50) return false;
    if (!poId.startsWith(`${expectedObBic}_`)) return false;
    return true;
}

// Format JS Date -> "YYYY-MM-DD HH:MM:SS"
function formatDatetime(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getUTCFullYear() + '-' +
        pad(d.getUTCMonth() + 1) + '-' +
        pad(d.getUTCDate()) + ' ' +
        pad(d.getUTCHours()) + ':' +
        pad(d.getUTCMinutes()) + ':' +
        pad(d.getUTCSeconds())
    );
}

// Normalize a PO before sending it externally (to CB or in API responses).
// Converts any Date / ISO string in *_datetime fields to "YYYY-MM-DD HH:MM:SS".
function normalizePoDates(po) {
    const out = { ...po };
    for (const key of ['po_datetime', 'ob_datetime', 'cb_datetime', 'bb_datetime']) {
        if (out[key] == null) continue;
        if (out[key] instanceof Date) {
            out[key] = formatDatetime(out[key]);
        } else if (typeof out[key] === 'string' && out[key].includes('T')) {
            // ISO string from JSON serialization of a Date
            const d = new Date(out[key]);
            if (!isNaN(d.getTime())) out[key] = formatDatetime(d);
        }
    }
    return out;
}

// Validate the full PO message shape per slide 16. Returns null if OK,
// or { code, message } for the first failure.
// Uses CB codes (4001-4007) where they apply, OWN codes (4100+) otherwise.
function validatePoMessage(po, { strictAllFields = false } = {}) {
    if (!po || typeof po !== 'object') return { code: OWN.VALIDATION_FAILED, message: 'PO is not an object' };

    if (!isValidBic(po.ob_id))            return { code: OWN.INVALID_BIC, message: 'invalid ob_id' };
    if (!isValidPoId(po.po_id, po.ob_id)) return { code: OWN.INVALID_PO_ID, message: 'invalid po_id (must be prefixed with ob_id_, max 50 chars)' };
    if (!po.po_message || typeof po.po_message !== 'string') return { code: OWN.VALIDATION_FAILED, message: 'po_message required' };
    if (!isValidDatetime(po.po_datetime)) return { code: OWN.INVALID_DATETIME, message: 'invalid po_datetime (need YYYY-MM-DD HH:MM:SS)' };
    if (!isValidIban(po.oa_id))           return { code: OWN.INVALID_IBAN, message: 'invalid oa_id (IBAN)' };

    // Amount checks - use CB codes 4002/4003 because the CB also enforces these
    const amount = Number(po.po_amount);
    if (!Number.isFinite(amount))         return { code: OWN.VALIDATION_FAILED, message: 'po_amount not numeric' };
    if (amount < 0)                        return { code: CB.AMOUNT_NEGATIVE, message: 'amount cannot be negative' };
    if (amount > MAX_PO_AMOUNT)            return { code: CB.AMOUNT_TOO_HIGH, message: 'amount exceeds 500 EUR limit' };
    if (Math.round(amount * 100) !== amount * 100) return { code: OWN.AMOUNT_BAD_DECIMALS, message: 'amount has more than 2 decimals' };

    if (strictAllFields) {
        if (!isValidBic(po.bb_id))        return { code: OWN.INVALID_BIC, message: 'invalid bb_id' };
        if (!isValidIban(po.ba_id))       return { code: OWN.INVALID_IBAN, message: 'invalid ba_id (IBAN)' };
    } else {
        if (po.bb_id != null && !isValidBic(po.bb_id))  return { code: OWN.INVALID_BIC, message: 'invalid bb_id' };
        if (po.ba_id != null && !isValidIban(po.ba_id)) return { code: OWN.INVALID_IBAN, message: 'invalid ba_id (IBAN)' };
    }

    return null;
}

module.exports = {
    isValidBic,
    isValidIban,
    isValidAmount,
    isValidDatetime,
    isValidPoId,
    formatDatetime,
    normalizePoDates,
    validatePoMessage,
    MAX_PO_AMOUNT,
};

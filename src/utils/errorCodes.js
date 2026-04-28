// src/utils/errorCodes.js
// Verified error codes from https://stevenop.be/pingfin/api/v2/errorcodes
//
// Two namespaces:
//   - CB codes (2000, 4001-4007): defined by Clearing Bank, MUST match exactly
//   - Our own codes (4100+, 5000+): for internal errors, must NOT collide with CB codes

// ----- Official CB codes (do not change values) -----
const CB = {
    OK:                          2000,  // No error detected
    INTERNAL_PO_TO_CB:           4001,  // OB == BB but PO sent to CB
    AMOUNT_TOO_HIGH:             4002,  // amount > 500 EUR
    AMOUNT_NEGATIVE:             4003,  // amount < 0
    UNKNOWN_BB:                  4004,  // bb_id not in CB system
    DUPLICATE_PO_PENDING:        4005,  // po_id already received (pending)
    OB_ID_MISMATCH:              4006,  // ob_id in PO != bank that sent it
    DUPLICATE_PO_IN_BATCH:       4007,  // multiple PO's with same po_id in one batch
};

// ----- Our own internal codes (4100+) -----
// IMPORTANT: never overlap with CB codes above!
const OWN = {
    VALIDATION_FAILED:    4100,  // generic validation error
    INSUFFICIENT_BALANCE: 4101,  // not enough money on OA
    OA_NOT_IN_BANK:       4102,  // OA does not exist in this bank
    BA_NOT_IN_BANK:       4103,  // BA expected internal but not in this bank
    INVALID_BIC:          4104,
    INVALID_IBAN:         4105,
    INVALID_DATETIME:     4106,
    INVALID_PO_ID:        4107,
    AMOUNT_BAD_DECIMALS:  4108,

    // Auth (4010-4019 reserved by us, doesn't collide with CB)
    AUTH_MISSING:         4010,
    AUTH_INVALID:         4011,

    // Server / infra
    NOT_FOUND:            4040,
    INTERNAL_ERROR:       5000,
    CB_UPSTREAM_ERROR:    5020,  // CB returned an error to us
};

const DESCRIPTIONS = {
    [CB.OK]:                    'No error detected',
    [CB.INTERNAL_PO_TO_CB]:     'Internal transaction (OB=BB) should not be sent to CB',
    [CB.AMOUNT_TOO_HIGH]:       'Transaction amount exceeds 500 EUR limit',
    [CB.AMOUNT_NEGATIVE]:       'Transaction amount cannot be negative',
    [CB.UNKNOWN_BB]:            'bb_id does not exist in the CB system',
    [CB.DUPLICATE_PO_PENDING]:  'po_id already received by CB (pending)',
    [CB.OB_ID_MISMATCH]:        'ob_id in PO does not match the sending bank',
    [CB.DUPLICATE_PO_IN_BATCH]: 'Multiple PO\'s with the same po_id in one batch',

    [OWN.VALIDATION_FAILED]:    'Validation failed',
    [OWN.INSUFFICIENT_BALANCE]: 'Insufficient balance on originator account',
    [OWN.OA_NOT_IN_BANK]:       'Originator account does not exist in this bank',
    [OWN.BA_NOT_IN_BANK]:       'Beneficiary account does not exist in this bank',
    [OWN.INVALID_BIC]:          'Invalid BIC format',
    [OWN.INVALID_IBAN]:         'Invalid IBAN format',
    [OWN.INVALID_DATETIME]:     'Invalid datetime format (need YYYY-MM-DD HH:MM:SS)',
    [OWN.INVALID_PO_ID]:        'Invalid po_id (must be prefixed with ob_id_, max 50 chars)',
    [OWN.AMOUNT_BAD_DECIMALS]:  'Amount has more than 2 decimal places',

    [OWN.AUTH_MISSING]:         'Missing or malformed Authorization header',
    [OWN.AUTH_INVALID]:         'Invalid admin token',

    [OWN.NOT_FOUND]:            'Endpoint not found',
    [OWN.INTERNAL_ERROR]:       'Internal server error',
    [OWN.CB_UPSTREAM_ERROR]:    'Clearing Bank returned an error',
};

function describe(code) {
    return DESCRIPTIONS[code] || `Unknown code ${code}`;
}

module.exports = { CB, OWN, DESCRIPTIONS, describe };

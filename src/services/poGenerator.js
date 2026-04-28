// src/services/poGenerator.js
// Generates random PO's for testing (slide 27/28).

const { query } = require('../db/pool');
const { formatDatetime } = require('../utils/validate');
const { banks } = require('../config');

// Tiny non-crypto random helpers
function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
    return arr[randInt(0, arr.length - 1)];
}

// Build a unique po_id: <OB_BIC>_<timestamp36>-<rand36>
function newPoId(obBic) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).substring(2, 8);
    return `${obBic}_${ts}-${rnd}`;
}

// Generate N PO's where the OB is `bankBic` (one of our banks).
// Mix of:
//  - internal (within same bank)
//  - external to our other bank
//  - external to a foreign bank (BIC unknown to CB -> will fail with 4004)
//  - some seeded errors (negative amount, > 500 EUR) for happy testing
async function generatePOs(bankBic, count = 10, options = {}) {
    const {
        testRunName = 'random-test',
        errorRatio  = 0.2, // 20% bad PO's by default
    } = options;

    // Fetch our accounts to pick OA from. BB/BA can be ours or external.
    const myAccountsRes = await query(
        `SELECT id FROM accounts WHERE bank_id = $1`,
        [bankBic]
    );
    if (myAccountsRes.rowCount === 0) {
        throw new Error(`No accounts found for bank ${bankBic}`);
    }
    const myIbans = myAccountsRes.rows.map(r => r.id);

    // The "other" bank we manage (if any) -> for internal-to-team testing
    const otherBank = banks.find(b => b.bic !== bankBic);
    let otherIbans = [];
    if (otherBank) {
        const r = await query(`SELECT id FROM accounts WHERE bank_id = $1`, [otherBank.bic]);
        otherIbans = r.rows.map(x => x.id);
    }

    // Some made-up foreign destinations (BICs other student teams might claim)
    const FOREIGN_BICS  = ['GKCCBEBB', 'KREDBEBB', 'BBRUBEBB', 'GEBABEBB'];
    const FOREIGN_IBANS = ['BE12345678901234', 'BE98765432109876', 'BE11223344556677'];

    const pos = [];
    for (let i = 0; i < count; i++) {
        const poId = newPoId(bankBic);
        const oaIban = pick(myIbans);

        // Decide PO flavour
        const r = Math.random();
        let bbId, baId, amount;

        if (r < 0.30 && otherBank) {
            // External to our other team-managed bank
            bbId = otherBank.bic;
            baId = pick(otherIbans);
        } else if (r < 0.60) {
            // Internal (same bank)
            bbId = bankBic;
            // pick a different IBAN than oa
            let cand = pick(myIbans);
            while (cand === oaIban && myIbans.length > 1) cand = pick(myIbans);
            baId = cand;
        } else {
            // External to a foreign bank
            bbId = pick(FOREIGN_BICS);
            baId = pick(FOREIGN_IBANS);
        }

        amount = randInt(1, 49999) / 100; // 0.01 to 499.99 EUR

        // Inject deliberate errors
        const isBad = Math.random() < errorRatio;
        if (isBad) {
            const which = randInt(1, 3);
            if (which === 1) amount = -randInt(1, 50);            // negative
            else if (which === 2) amount = randInt(501, 9999);    // > 500
            // which === 3: leave as-is, format-valid; tests happy path
        }

        pos.push({
            po_id:       poId,
            po_amount:   amount,
            po_message:  `${testRunName} #${i + 1}`,
            po_datetime: formatDatetime(new Date()),
            ob_id:       bankBic,
            oa_id:       oaIban,
            ob_code:     null,
            ob_datetime: null,
            cb_code:     null,
            cb_datetime: null,
            bb_id:       bbId,
            ba_id:       baId,
            bb_code:     null,
            bb_datetime: null,
        });
    }

    return pos;
}

module.exports = { generatePOs, newPoId };

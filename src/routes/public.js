// src/routes/public.js
// Public endpoints required for a regular bank (slide 21):
//   GET /api/help      - overview of API
//   GET /api/info      - team & bank info
//   GET /api/accounts  - all accounts (per bank context)

const express = require('express');
const { query } = require('../db/pool');
const { ok, fail } = require('../utils/response');
const { bankContext } = require('../middleware/bankContext');
const { banks } = require('../config');
const { OWN } = require('../utils/errorCodes');
const { log, LOG_TYPES } = require('../services/logger');

const router = express.Router();

// ----- /api/help -----
router.get('/help', (req, res) => {
    return ok(res, {
        team: 18,
        banks: banks.map(b => b.bic),
        public_endpoints: {
            'GET  /api/help':     'this overview',
            'GET  /api/info':     'team and bank info (requires bank context)',
            'GET  /api/accounts': 'list all accounts of the selected bank (requires bank context)',
        },
        internal_endpoints: {
            'GET  /api/po_new_generate':   'generate N random PO\'s (preview, not inserted)',
            'POST /api/po_new_add':        'add PO\'s to PO_NEW. Body: { data: [...] } or { generate: N }',
            'GET  /api/po_new_process':    'OB-side: validate, internal->TX, external->debit OA + PO_OUT + CB.PO_IN',
            'GET  /api/po_in_fetch':       'BB-side: pull PO_OUT from CB into our PO_IN (DESTRUCTIVE on CB)',
            'GET  /api/po_in_process':    'BB-side: validate, credit BA, send ACK back via CB.ACK_IN',
            'GET  /api/ack_in_fetch':     'OB-side close: pull ACK_OUT from CB; complete or refund TX',
            'POST /api/test/full_cycle':   'self-test: run full OB->BB->ACK cycle between our 2 banks',
            'GET  /api/po_new':            'list rows in PO_NEW',
            'GET  /api/po_out':            'list rows in PO_OUT',
            'GET  /api/po_in':             'list rows in PO_IN',
            'GET  /api/ack_in':            'list rows in ACK_IN',
            'GET  /api/ack_out':           'list rows in ACK_OUT',
            'GET  /api/outstanding':       'PO_OUT entries without ACK_IN match (?hours=1 for >1h)',
            'GET  /api/transactions':      'recent 200 transactions',
            'GET  /api/log':               'recent 500 log entries',
            'POST /api/cb/refresh_token':  'force a fresh CB bearer token',
            'GET  /api/cb/banks':          'list all banks registered at the CB',
            'POST /api/cb/banks':          'update OUR bank info at CB. Body: { name, members }',
            'GET  /api/cb/po_out_peek':    'READ-ONLY peek at CB.PO_OUT (no consume)',
            'GET  /api/cb/ack_out_peek':   'READ-ONLY peek at CB.ACK_OUT (no consume)',
            'GET  /api/cb/errorcodes':     'official CB error code list (proxy)',
            'GET  /api/cb/global_log':     'global CB log across all teams',
        },
        bank_context: {
            description: 'Endpoints touching bank data require X-Bank-BIC header or ?bank=<BIC>',
            allowed: banks.map(b => b.bic),
        },
        admin_auth: {
            description: 'Internal endpoints require Authorization: Bearer <ADMIN_TOKEN>',
        },
        response_shape: {
            ok:      'true|false',
            status:  'HTTP status code',
            code:    'business code: 2000=OK, 4001-4007=CB codes, 4100+=our codes',
            message: 'human readable message',
            data:    'payload (array, object, or null)',
        },
        cb_endpoint: 'https://stevenop.be/pingfin/api/v2',
    }, 'PingFin team 18 API');
});

// ----- /api/info -----
router.get('/info', bankContext, (req, res) => {
    const bank = banks.find(b => b.bic === req.bankBic);
    return ok(res, {
        team: 18,
        members: ['Danick , Saartje, Victor, Mesut'],
        bank: {
            bic:  bank.bic,
            name: bank.name,
        },
        all_managed_banks: banks.map(b => ({ bic: b.bic, name: b.name })),
    });
});

// ----- /api/accounts -----
router.get('/accounts', bankContext, async (req, res) => {
    try {
        const r = await query(
            `SELECT id, bank_id, balance
               FROM accounts
              WHERE bank_id = $1
              ORDER BY id`,
            [req.bankBic]
        );
        return ok(res, r.rows, `${r.rowCount} accounts for ${req.bankBic}`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `GET /api/accounts failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: 'internal error' });
    }
});

module.exports = router;

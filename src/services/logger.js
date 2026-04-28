// src/services/logger.js
// Writes to the `log` table per slide 14. Also mirrors to console.

const { query } = require('../db/pool');

const LOG_TYPES = {
    GENERAL:   'general',
    SYSTEM:    'system',
    EXCEPTION: 'exception',
    PO_NEW:    'po_new',
    PO_OUT:    'po_out',
    PO_IN:     'po_in',
    ACK_OUT:   'ack_out',
    ACK_IN:    'ack_in',
    TX:        'transaction',
    API_IN:    'api_in',     // incoming API call to us
    API_OUT:   'api_out',    // outgoing API call we made
    AUTH:      'auth',
};

async function log(bankId, type, message) {
    // Mirror to console for live debugging
    const prefix = bankId ? `[${bankId}]` : '[SYSTEM]';
    console.log(`${prefix} ${type}: ${message}`);

    // Persist
    try {
        await query(
            `INSERT INTO log (bank_id, type, message) VALUES ($1, $2, $3)`,
            [bankId, type, message]
        );
    } catch (err) {
        // Don't crash the app if logging fails
        console.error('[logger] Failed to persist log:', err.message);
    }
}

module.exports = { log, LOG_TYPES };

// src/config.js
// Loads .env and exposes typed config. Single source of truth.

require('dotenv').config();

function required(name) {
    const v = process.env[name];
    if (!v) {
        console.error(`[config] Missing required env var: ${name}`);
        process.exit(1);
    }
    return v;
}

const config = {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    databaseUrl: required('DATABASE_URL'),

    cbBaseUrl: process.env.CB_BASE_URL || 'https://stevenop.be/pingfin/api/v2',

    // Our 2 banks. Iterable -> easy to loop over for token refresh, etc.
    banks: [
        {
            bic: required('BANK1_BIC'),
            name: process.env.BANK1_NAME || 'Bank 1',
            secret: required('BANK1_SECRET'),
        },
        {
            bic: required('BANK2_BIC'),
            name: process.env.BANK2_NAME || 'Bank 2',
            secret: required('BANK2_SECRET'),
        },
    ],

    adminTokens: (process.env.ADMIN_TOKENS || '')
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
};

// Quick lookup helpers
config.bankByBic = (bic) => config.banks.find(b => b.bic === bic) || null;
config.isOurBank = (bic) => config.banks.some(b => b.bic === bic);

module.exports = config;

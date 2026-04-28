// src/db/pool.js
// Single shared pg Pool, used everywhere. Don't create new clients elsewhere.

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
    connectionString: config.databaseUrl,
    // Railway requires SSL; rejectUnauthorized false because Railway proxy
    // uses a cert chain Node doesn't trust by default.
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err);
});

// Convenience: query with auto-release
async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    if (config.nodeEnv === 'development') {
        const ms = Date.now() - start;
        console.log(`[db] (${ms}ms) ${text.split('\n')[0].substring(0, 80)}... -> ${res.rowCount} rows`);
    }
    return res;
}

// Transaction helper - pass an async fn that receives a client
async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { pool, query, withTransaction };

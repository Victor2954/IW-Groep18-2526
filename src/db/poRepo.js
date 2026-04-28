// src/db/poRepo.js
// All DB access for PO-flavored tables (po_new, po_out, po_in, ack_in, ack_out).
// Centralizing here keeps SQL out of route handlers.

const { query, withTransaction } = require('./pool');

// All 14 PO message fields (slide 16). Order matters for INSERT.
const PO_FIELDS = [
    'po_id', 'po_amount', 'po_message', 'po_datetime',
    'ob_id', 'oa_id', 'ob_code', 'ob_datetime',
    'cb_code', 'cb_datetime',
    'bb_id', 'ba_id', 'bb_code', 'bb_datetime',
];

// Build "($1,$2,...,$N), ($N+1,...)" param list for bulk insert
function buildBulkInsert(table, rows, extraColumns = ['bank_id']) {
    const allCols = [...extraColumns, ...PO_FIELDS];
    const colSql = allCols.join(', ');

    const valuesSql = [];
    const params = [];
    let p = 1;

    for (const row of rows) {
        const placeholders = allCols.map(() => `$${p++}`);
        valuesSql.push(`(${placeholders.join(', ')})`);
        for (const col of allCols) {
            params.push(row[col] === undefined ? null : row[col]);
        }
    }

    return {
        sql: `INSERT INTO ${table} (${colSql}) VALUES ${valuesSql.join(', ')} ON CONFLICT (po_id) DO NOTHING RETURNING po_id`,
        params,
    };
}

// ----- PO_NEW -----
async function insertPoNew(rows /* with bank_id */) {
    if (rows.length === 0) return [];
    const { sql, params } = buildBulkInsert('po_new', rows);
    const r = await query(sql, params);
    return r.rows.map(x => x.po_id);
}

async function listPoNew(bankBic) {
    const r = await query(`SELECT * FROM po_new WHERE bank_id = $1 ORDER BY po_datetime`, [bankBic]);
    return r.rows;
}

async function deletePoNew(client, poId) {
    await client.query(`DELETE FROM po_new WHERE po_id = $1`, [poId]);
}

// ----- PO_OUT -----
async function insertPoOut(client, row) {
    const cols = ['bank_id', ...PO_FIELDS];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const params = cols.map(c => row[c] === undefined ? null : row[c]);
    await client.query(
        `INSERT INTO po_out (${cols.join(', ')}) VALUES (${placeholders})`,
        params
    );
}

async function listPoOut(bankBic) {
    const r = await query(`SELECT * FROM po_out WHERE bank_id = $1 ORDER BY ob_datetime DESC`, [bankBic]);
    return r.rows;
}

async function listOutstandingPoOut(bankBic, hoursOld = null) {
    // Outstanding = no matching ack_in row yet
    let sql = `
        SELECT po.*
          FROM po_out po
          LEFT JOIN ack_in ai ON ai.po_id = po.po_id
         WHERE po.bank_id = $1
           AND ai.po_id IS NULL
    `;
    const params = [bankBic];
    if (hoursOld != null) {
        sql += ` AND po.ob_datetime < (NOW() - INTERVAL '${Number(hoursOld)} hours')`;
    }
    sql += ` ORDER BY po.ob_datetime`;
    const r = await query(sql, params);
    return r.rows;
}

// ----- PO_IN -----
async function insertPoIn(rows) {
    if (rows.length === 0) return [];
    const { sql, params } = buildBulkInsert('po_in', rows);
    const r = await query(sql, params);
    return r.rows.map(x => x.po_id);
}

async function listPoIn(bankBic) {
    const r = await query(`SELECT * FROM po_in WHERE bank_id = $1 ORDER BY cb_datetime`, [bankBic]);
    return r.rows;
}

async function deletePoIn(client, poId) {
    await client.query(`DELETE FROM po_in WHERE po_id = $1`, [poId]);
}

// ----- ACK_OUT -----
async function insertAckOut(client, row) {
    const cols = ['bank_id', ...PO_FIELDS];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const params = cols.map(c => row[c] === undefined ? null : row[c]);
    await client.query(
        `INSERT INTO ack_out (${cols.join(', ')}) VALUES (${placeholders})`,
        params
    );
}

async function listAckOut(bankBic) {
    const r = await query(`SELECT * FROM ack_out WHERE bank_id = $1 ORDER BY bb_datetime DESC`, [bankBic]);
    return r.rows;
}

// ----- ACK_IN -----
async function insertAckIn(rows) {
    if (rows.length === 0) return [];
    const { sql, params } = buildBulkInsert('ack_in', rows);
    const r = await query(sql, params);
    return r.rows.map(x => x.po_id);
}

async function listAckIn(bankBic) {
    const r = await query(`SELECT * FROM ack_in WHERE bank_id = $1 ORDER BY bb_datetime DESC`, [bankBic]);
    return r.rows;
}

module.exports = {
    PO_FIELDS,
    insertPoNew, listPoNew, deletePoNew,
    insertPoOut, listPoOut, listOutstandingPoOut,
    insertPoIn,  listPoIn,  deletePoIn,
    insertAckOut, listAckOut,
    insertAckIn, listAckIn,
    withTransaction,
};

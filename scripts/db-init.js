// scripts/db-init.js
// Reads sql/schema.sql and executes it against DATABASE_URL.
// Usage: npm run db:init

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        console.error('DATABASE_URL not set in .env');
        process.exit(1);
    }

    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');

    const client = new Client({
        connectionString: url,
        ssl: { rejectUnauthorized: false },
    });

    console.log('Connecting to Railway...');
    await client.connect();
    console.log('Connected. Executing schema.sql ...');

    try {
        await client.query(sql);
        console.log('Schema applied successfully.');

        // Quick sanity check
        const r = await client.query(`SELECT COUNT(*)::int AS n FROM accounts`);
        console.log(`accounts table now has ${r.rows[0].n} rows.`);
    } catch (err) {
        console.error('Schema execution failed:', err.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});

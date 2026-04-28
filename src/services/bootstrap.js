// src/services/bootstrap.js
// Runs once at server startup:
//   - Pre-warms CB tokens for both banks
//   - Auto-registers our team info at the CB via POST /banks
//
// Reads from env: BANK1_NAME, BANK2_NAME, TEAM_MEMBERS

const { banks } = require('../config');
const cb = require('./cbClient');
const { log, LOG_TYPES } = require('./logger');

async function autoRegister() {
    const members = process.env.TEAM_MEMBERS || 'Team 18 - HER 3-5306';

    for (const bank of banks) {
        try {
            // Step 1: warm token
            await cb.getToken(bank.bic);

            // Step 2: push our info
            const r = await cb.cbUpdateBank(bank.bic, {
                name: bank.name,
                members,
            });

            if (r.ok) {
                await log(bank.bic, LOG_TYPES.SYSTEM, `Auto-registered at CB: name="${bank.name}", members="${members}"`);
                console.log(`[bootstrap] ${bank.bic} registered at CB`);
            } else {
                await log(bank.bic, LOG_TYPES.EXCEPTION, `Auto-register failed HTTP ${r.status}: ${JSON.stringify(r.body).substring(0, 200)}`);
                console.warn(`[bootstrap] ${bank.bic} register failed: HTTP ${r.status}`);
            }
        } catch (err) {
            await log(bank.bic, LOG_TYPES.EXCEPTION, `Auto-register threw: ${err.message}`);
            console.warn(`[bootstrap] ${bank.bic} register error: ${err.message}`);
        }
    }
}

module.exports = { autoRegister };

// src/routes/internal.js
// Internal endpoints implementing the SEPA messaging flow (slide 17).
//
// OB-side flow:
//   1. /po_new_generate or /po_new_add  -> PO_NEW
//   2. /po_new_process                  -> validate -> PO_OUT (move) -> POST to CB.PO_IN
//      If OB validation fails: log error, do NOT move to PO_OUT, delete from PO_NEW
//      If internal payment (BB == one of our banks): book TX directly, no CB call
//   3. /ack_in_fetch                    -> GET CB.ACK_OUT -> ACK_IN -> finalize TX
//
// BB-side flow:
//   4. /po_in_fetch                     -> GET CB.PO_OUT -> PO_IN
//   5. /po_in_process                   -> validate -> book TX -> ACK_OUT (move) -> POST to CB.ACK_IN

const express = require('express');
const { query, withTransaction } = require('../db/pool');
const repo = require('../db/poRepo');
const { ok, fail } = require('../utils/response');
const { bankContext } = require('../middleware/bankContext');
const { adminAuth } = require('../middleware/adminAuth');
const { log, LOG_TYPES } = require('../services/logger');
const { generatePOs } = require('../services/poGenerator');
const { validatePoMessage, formatDatetime, isValidIban, normalizePoDates } = require('../utils/validate');
const { CB, OWN } = require('../utils/errorCodes');
const { isOurBank } = require('../config');
const cb = require('../services/cbClient');

const router = express.Router();

// All internal endpoints need admin auth + bank context.
router.use(adminAuth);
router.use(bankContext);

// =====================================================================
// /api/po_new_generate?count=10  (GET)
// Generates random PO's. Does NOT insert; returns them so admin can preview.
// =====================================================================
router.get('/po_new_generate', async (req, res) => {
    try {
        const count = Math.min(parseInt(req.query.count || '10', 10), 100);
        const errorRatio = req.query.error_ratio != null ? Number(req.query.error_ratio) : 0.2;
        const pos = await generatePOs(req.bankBic, count, { errorRatio });
        await log(req.bankBic, LOG_TYPES.PO_NEW, `Generated ${pos.length} candidate PO's (preview, not inserted)`);
        return ok(res, pos, `${pos.length} PO's generated (preview)`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `po_new_generate failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// /api/po_new_add  (POST)
// Body: { data: [PO, PO, ...] } OR { generate: N } to auto-generate+insert.
// =====================================================================
router.post('/po_new_add', async (req, res) => {
    try {
        let pos = [];
        if (req.body && Array.isArray(req.body.data)) {
            pos = req.body.data;
        } else if (req.body && typeof req.body.generate === 'number') {
            pos = await generatePOs(req.bankBic, req.body.generate, {
                errorRatio: req.body.error_ratio ?? 0.2,
                testRunName: req.body.test_run_name || 'random-test',
            });
        } else {
            return fail(res, { status: 400, code: OWN.VALIDATION_FAILED, message: 'body must contain { data: [...] } or { generate: N }' });
        }

        // Light shape check (we accept invalid amounts here -- they'll fail at validation)
        const rows = pos.map(po => ({
            ...po,
            bank_id: req.bankBic,
            ob_id:   po.ob_id || req.bankBic,
        }));

        const inserted = await repo.insertPoNew(rows);
        await log(req.bankBic, LOG_TYPES.PO_NEW, `Added ${inserted.length}/${rows.length} PO's to PO_NEW`);
        return ok(res, { inserted_po_ids: inserted, requested: rows.length }, `${inserted.length} PO's added`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `po_new_add failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// /api/po_new_process  (GET)
// Per PO in PO_NEW for this bank:
//   - validate (OB checks: IBAN, amount, account exists, balance >=0 after debit)
//   - if invalid: log + remove from PO_NEW (do not move)
//   - if internal (bb_id is one of our banks): book both TX rows + remove from PO_NEW (no CB)
//   - if external: move to PO_OUT (with ob_code 2000, ob_datetime now)
// At the end: bulk POST all newly-created external PO_OUT rows to CB.PO_IN.
// =====================================================================
router.get('/po_new_process', async (req, res) => {
    try {
        const candidates = await repo.listPoNew(req.bankBic);
        if (candidates.length === 0) {
            return ok(res, { processed: 0 }, 'PO_NEW is empty');
        }

        const result = {
            total:        candidates.length,
            invalid:      0,
            internal_ok:  0,
            internal_fail: 0,
            external_ok:  0,   // moved to po_out
            cb_sent:      0,   // successfully POSTed to CB
            cb_failed:    0,
            details:      [],
        };

        // Collect external PO's to send in one batch at the end
        const externalToSend = [];

        for (const po of candidates) {
            try {
                // 1) OB validation
                const v = validatePoMessage(po, { strictAllFields: true });
                if (v) {
                    result.invalid++;
                    result.details.push({ po_id: po.po_id, outcome: 'invalid', code: v.code, message: v.message });
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `OB validation FAIL po=${po.po_id} code=${v.code} msg=${v.message}`);
                    await withTransaction(async (client) => { await repo.deletePoNew(client, po.po_id); });
                    continue;
                }

                // 2) Account checks - OA must exist on THIS bank
                const oaRes = await query(
                    `SELECT balance FROM accounts WHERE id = $1 AND bank_id = $2 FOR UPDATE`,
                    [po.oa_id, req.bankBic]
                );
                if (oaRes.rowCount === 0) {
                    result.invalid++;
                    result.details.push({ po_id: po.po_id, outcome: 'invalid', code: OWN.OA_NOT_IN_BANK, message: 'OA not in this bank' });
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `OB validation FAIL po=${po.po_id}: OA ${po.oa_id} not in ${req.bankBic}`);
                    await withTransaction(async (client) => { await repo.deletePoNew(client, po.po_id); });
                    continue;
                }
                const balance = Number(oaRes.rows[0].balance);
                const amount  = Number(po.po_amount);
                if (balance < amount) {
                    result.invalid++;
                    result.details.push({ po_id: po.po_id, outcome: 'invalid', code: OWN.INSUFFICIENT_BALANCE, message: 'insufficient balance' });
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `OB validation FAIL po=${po.po_id}: balance ${balance} < ${amount}`);
                    await withTransaction(async (client) => { await repo.deletePoNew(client, po.po_id); });
                    continue;
                }

                // 3) Internal vs external
                const isInternal = (po.bb_id === req.bankBic);

                if (isInternal) {
                    // Book TX directly: debit OA, credit BA. Both within same bank/DB tx.
                    // First confirm BA exists and belongs to this bank.
                    await withTransaction(async (client) => {
                        const baRes = await client.query(
                            `SELECT balance FROM accounts WHERE id = $1 AND bank_id = $2 FOR UPDATE`,
                            [po.ba_id, req.bankBic]
                        );
                        if (baRes.rowCount === 0) {
                            throw new Error(`BA ${po.ba_id} not in bank ${req.bankBic}`);
                        }

                        const now = formatDatetime(new Date());
                        // Debit
                        await client.query(`UPDATE accounts SET balance = balance - $1 WHERE id = $2`, [amount, po.oa_id]);
                        await client.query(
                            `INSERT INTO transactions (bank_id, amount, datetime, po_id, account_id, isvalid, iscomplete)
                             VALUES ($1, $2, $3, $4, $5, true, true)`,
                            [req.bankBic, -amount, now, po.po_id, po.oa_id]
                        );
                        // Credit
                        await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [amount, po.ba_id]);
                        await client.query(
                            `INSERT INTO transactions (bank_id, amount, datetime, po_id, account_id, isvalid, iscomplete)
                             VALUES ($1, $2, $3, $4, $5, true, true)`,
                            [req.bankBic, amount, now, po.po_id, po.ba_id]
                        );
                        await repo.deletePoNew(client, po.po_id);
                    });

                    result.internal_ok++;
                    result.details.push({ po_id: po.po_id, outcome: 'internal_booked' });
                    await log(req.bankBic, LOG_TYPES.TX, `Internal payment booked po=${po.po_id} amount=${amount}`);
                } else {
                    // External: debit OA NOW (optimistic), move to PO_OUT, then send to CB.
                    // If BB later rejects (ACK with bb_code != 2000), we refund in /ack_in_fetch.
                    // This guarantees slide 14's "balance can not go below zero" rule.
                    const now = formatDatetime(new Date());
                    const enriched = {
                        ...po,
                        bank_id:     req.bankBic,
                        ob_code:     CB.OK,
                        ob_datetime: now,
                    };
                    await withTransaction(async (client) => {
                        // Debit OA
                        await client.query(
                            `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
                            [amount, po.oa_id]
                        );
                        // Audit TX (negative, NOT yet complete - waits for ACK_IN)
                        await client.query(
                            `INSERT INTO transactions (bank_id, amount, datetime, po_id, account_id, isvalid, iscomplete)
                             VALUES ($1, $2, $3, $4, $5, true, false)`,
                            [req.bankBic, -amount, now, po.po_id, po.oa_id]
                        );
                        await repo.insertPoOut(client, enriched);
                        await repo.deletePoNew(client, po.po_id);
                    });
                    externalToSend.push(enriched);
                    result.external_ok++;
                    result.details.push({ po_id: po.po_id, outcome: 'moved_to_po_out_and_debited' });
                    await log(req.bankBic, LOG_TYPES.PO_OUT, `Debited OA + moved to PO_OUT po=${po.po_id} bb=${po.bb_id}`);
                }
            } catch (errPo) {
                result.invalid++;
                result.details.push({ po_id: po.po_id, outcome: 'error', message: errPo.message });
                await log(req.bankBic, LOG_TYPES.EXCEPTION, `Processing po=${po.po_id} failed: ${errPo.message}`);
            }
        }

        // Send external batch to CB
        if (externalToSend.length > 0) {
            try {
                // Normalize datetime fields to "YYYY-MM-DD HH:MM:SS" string format
                // (slide 15 spec) before sending to CB.
                const normalized = externalToSend.map(normalizePoDates);
                const cbResp = await cb.cbPostPoIn(req.bankBic, normalized);
                if (cbResp.ok) {
                    result.cb_sent = externalToSend.length;
                    await log(req.bankBic, LOG_TYPES.PO_OUT, `Sent ${externalToSend.length} PO's to CB.PO_IN -> HTTP ${cbResp.status}`);
                } else {
                    result.cb_failed = externalToSend.length;
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `CB.PO_IN POST returned HTTP ${cbResp.status}`);
                }
            } catch (cbErr) {
                result.cb_failed = externalToSend.length;
                await log(req.bankBic, LOG_TYPES.EXCEPTION, `CB.PO_IN POST threw: ${cbErr.message}`);
            }
        }

        return ok(res, result, `Processed ${result.total} PO's`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `po_new_process failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// BB-FLOW: when we are the Beneficiary Bank
// =====================================================================
//
// Step 1: /po_in_fetch - pull PO's from CB.PO_OUT into our po_in table
// Step 2: /po_in_process - validate, book TX, create ACK_OUT, push to CB.ACK_IN
// Step 3 (OB-side closing): /ack_in_fetch - pull ACK's from CB.ACK_OUT
//
// Key choices:
// - Per slide 17 ("validation failed" pijl): we ALWAYS send an ACK back,
//   even on failure. The bb_code in that ACK uses official CB codes only.
// - po_in -> ack_out is a MOVE (per your earlier choice). When TX is booked
//   for OK case, the po_in row is deleted as part of the same DB transaction.

// =====================================================================
// /api/po_in_fetch  (GET)
// Pulls from CB.PO_OUT (DESTRUCTIVE - items leave CB queue) and inserts
// into our po_in table. Filters: only keep PO's where bb_id matches the
// requested bank_id (defensive: shouldn't happen, but guards against
// wrong-token scenarios).
// =====================================================================
router.get('/po_in_fetch', async (req, res) => {
    try {
        const cbResp = await cb.cbConsumePoOut(req.bankBic);
        if (!cbResp.ok) {
            await log(req.bankBic, LOG_TYPES.EXCEPTION, `cbConsumePoOut returned HTTP ${cbResp.status}`);
            return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: 'CB returned non-OK', data: cbResp.body });
        }

        // CB returns { ok, status, data: [PO,...] }
        const incoming = Array.isArray(cbResp.body?.data) ? cbResp.body.data : [];

        if (incoming.length === 0) {
            await log(req.bankBic, LOG_TYPES.PO_IN, `Fetched 0 PO's from CB`);
            return ok(res, { fetched: 0, inserted: 0 }, 'Nothing to fetch');
        }

        // Defensive: only accept PO's where we are actually BB
        const valid = incoming.filter(po => po.bb_id === req.bankBic);
        const wrong = incoming.length - valid.length;
        if (wrong > 0) {
            await log(req.bankBic, LOG_TYPES.EXCEPTION, `CB returned ${wrong} PO's not addressed to ${req.bankBic} (ignoring)`);
        }

        // Tag with bank_id and insert into po_in
        const rows = valid.map(po => ({ ...po, bank_id: req.bankBic }));
        const inserted = await repo.insertPoIn(rows);

        await log(req.bankBic, LOG_TYPES.PO_IN, `Fetched ${incoming.length} from CB, inserted ${inserted.length} into PO_IN`);
        return ok(res, {
            fetched: incoming.length,
            inserted: inserted.length,
            ignored_wrong_bb: wrong,
            inserted_po_ids: inserted,
        }, `Fetched ${inserted.length} PO's into PO_IN`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `po_in_fetch failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// /api/po_in_process  (GET)
// For each PO in po_in: validate as BB, book TX (credit BA) if OK,
// always create an ACK_OUT row (even on failure - per slide 17 "validation
// failed" arrow), then batch-POST all ACK_OUT rows to CB.ACK_IN.
//
// bb_code values sent to CB are OFFICIAL codes only:
//   2000 = OK
//   4004 = bb_id/ba_id unknown (matches CB's "id not in system" semantics)
//   4001 = generic BB-side rejection
// =====================================================================
router.get('/po_in_process', async (req, res) => {
    try {
        const candidates = await repo.listPoIn(req.bankBic);
        if (candidates.length === 0) {
            return ok(res, { processed: 0 }, 'PO_IN is empty');
        }

        const result = {
            total:        candidates.length,
            booked_ok:    0,
            rejected:     0,
            cb_sent:      0,
            cb_failed:    0,
            details:      [],
        };

        const acksToSend = [];

        for (const po of candidates) {
            const now = formatDatetime(new Date());
            let bbCode;
            let bookedOk = false;

            try {
                // BB validation: BA must exist in this bank
                if (!isValidIban(po.ba_id)) {
                    bbCode = CB.INTERNAL_PO_TO_CB; // 4001 - generic rejection
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `BB reject po=${po.po_id}: invalid ba_id format`);
                } else {
                    // Try to book TX in a single DB transaction
                    await withTransaction(async (client) => {
                        const baRes = await client.query(
                            `SELECT balance FROM accounts WHERE id = $1 AND bank_id = $2 FOR UPDATE`,
                            [po.ba_id, req.bankBic]
                        );

                        if (baRes.rowCount === 0) {
                            // BA not found in our bank -> reject with 4004
                            bbCode = CB.UNKNOWN_BB; // 4004
                            await log(req.bankBic, LOG_TYPES.EXCEPTION, `BB reject po=${po.po_id}: BA ${po.ba_id} not in ${req.bankBic}`);
                            // Just delete from po_in, no TX booked
                            await repo.deletePoIn(client, po.po_id);
                            return;
                        }

                        // Happy path: credit BA
                        const amount = Number(po.po_amount);
                        await client.query(
                            `UPDATE accounts SET balance = balance + $1 WHERE id = $2`,
                            [amount, po.ba_id]
                        );
                        await client.query(
                            `INSERT INTO transactions (bank_id, amount, datetime, po_id, account_id, isvalid, iscomplete)
                             VALUES ($1, $2, $3, $4, $5, true, true)`,
                            [req.bankBic, amount, now, po.po_id, po.ba_id]
                        );
                        await repo.deletePoIn(client, po.po_id);
                        bbCode = CB.OK; // 2000
                        bookedOk = true;
                    });
                }
            } catch (errPo) {
                bbCode = CB.INTERNAL_PO_TO_CB; // 4001 fallback
                await log(req.bankBic, LOG_TYPES.EXCEPTION, `BB processing po=${po.po_id} threw: ${errPo.message}`);
            }

            // Build ACK row (full PO message + bb_code + bb_datetime)
            const ackRow = {
                ...po,
                bank_id:     req.bankBic,
                bb_code:     bbCode,
                bb_datetime: now,
            };

            // Insert into our ack_out table (audit trail)
            try {
                await withTransaction(async (client) => {
                    await repo.insertAckOut(client, ackRow);
                });
            } catch (insErr) {
                await log(req.bankBic, LOG_TYPES.EXCEPTION, `Failed to insert ack_out po=${po.po_id}: ${insErr.message}`);
            }

            // Build the ACK payload to send to CB (without our internal bank_id field)
            const { bank_id: _omit, ...ackForCb } = ackRow;
            acksToSend.push(ackForCb);

            if (bookedOk) {
                result.booked_ok++;
                result.details.push({ po_id: po.po_id, outcome: 'booked', bb_code: bbCode });
                await log(req.bankBic, LOG_TYPES.TX, `BB credited BA=${po.ba_id} amount=${po.po_amount} po=${po.po_id}`);
            } else {
                result.rejected++;
                result.details.push({ po_id: po.po_id, outcome: 'rejected', bb_code: bbCode });
            }
        }

        // Push ACK batch to CB
        if (acksToSend.length > 0) {
            try {
                const normalizedAcks = acksToSend.map(normalizePoDates);
                const cbResp = await cb.cbPostAckIn(req.bankBic, normalizedAcks);
                if (cbResp.ok) {
                    result.cb_sent = acksToSend.length;
                    await log(req.bankBic, LOG_TYPES.ACK_OUT, `Sent ${acksToSend.length} ACKs to CB.ACK_IN -> HTTP ${cbResp.status}`);
                } else {
                    result.cb_failed = acksToSend.length;
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `CB.ACK_IN returned HTTP ${cbResp.status}: ${JSON.stringify(cbResp.body).substring(0, 200)}`);
                }
            } catch (cbErr) {
                result.cb_failed = acksToSend.length;
                await log(req.bankBic, LOG_TYPES.EXCEPTION, `CB.ACK_IN POST threw: ${cbErr.message}`);
            }
        }

        return ok(res, result, `Processed ${result.total} PO_IN entries`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `po_in_process failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// /api/ack_in_fetch  (GET)
// Closes the OB-side cycle: pulls ACKs from CB.ACK_OUT (DESTRUCTIVE) and
// inserts them into our ack_in table. Outstanding PO_OUT rows are now
// matched by these ACKs.
// We do NOT auto-debit OA here, because the OA was already debited at
// PO_OUT time? -- NO, actually we did NOT debit at PO_OUT time. Let's
// check the design:
//
// CHOICE: when do we debit OA for external payments?
//   Option (i)  - at PO_OUT time (optimistic): the money leaves immediately,
//                 ACK just confirms. If CB times out, we have to refund.
//   Option (ii) - at ACK_IN time (pessimistic): we hold the funds (no
//                 actual debit yet) until BB confirms via ACK.
//
// Slide 14: "every outstanding payment order should receive an
// acknowledgement within 1 hour" + "an account balance can not go below
// zero". With option (ii), we'd need to "reserve" funds somehow. Easiest
// realistic compromise: debit at PO_OUT time, and if ACK comes back with
// non-OK bb_code, REFUND the OA in this endpoint. That's what we'll do.
//
// NOTE: this means /po_new_process should ALSO debit OA when moving to
// PO_OUT. Currently it does not. We add that below in this PR.
// =====================================================================
router.get('/ack_in_fetch', async (req, res) => {
    try {
        const cbResp = await cb.cbConsumeAckOut(req.bankBic);
        if (!cbResp.ok) {
            return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: 'CB returned non-OK', data: cbResp.body });
        }

        const incoming = Array.isArray(cbResp.body?.data) ? cbResp.body.data : [];
        if (incoming.length === 0) {
            return ok(res, { fetched: 0 }, 'No ACKs waiting');
        }

        // Defensive: keep only ACKs where we are OB
        const valid = incoming.filter(p => p.ob_id === req.bankBic);
        const rows = valid.map(p => ({ ...p, bank_id: req.bankBic }));
        const inserted = await repo.insertAckIn(rows);

        // Process each ACK: refund OA if BB rejected
        let refunded = 0;
        let confirmed = 0;
        const details = [];

        for (const ack of valid) {
            const bbCode = Number(ack.bb_code);
            if (bbCode === CB.OK) {
                // BB accepted - mark our debit TX as complete
                try {
                    await query(
                        `UPDATE transactions
                            SET iscomplete = true
                          WHERE po_id = $1 AND bank_id = $2 AND amount < 0`,
                        [ack.po_id, req.bankBic]
                    );
                    confirmed++;
                    details.push({ po_id: ack.po_id, outcome: 'confirmed' });
                    await log(req.bankBic, LOG_TYPES.ACK_IN, `ACK OK po=${ack.po_id} -> TX marked complete`);
                } catch (e) {
                    details.push({ po_id: ack.po_id, outcome: 'confirm_failed', error: e.message });
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `Confirm TX failed po=${ack.po_id}: ${e.message}`);
                }
            } else {
                // BB rejected - refund OA + mark debit TX as invalid
                try {
                    await withTransaction(async (client) => {
                        const amount = Number(ack.po_amount);
                        // Refund: credit OA back
                        await client.query(
                            `UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND bank_id = $3`,
                            [amount, ack.oa_id, req.bankBic]
                        );
                        // Mark original debit TX as invalid (not complete)
                        await client.query(
                            `UPDATE transactions
                                SET isvalid = false, iscomplete = true
                              WHERE po_id = $1 AND bank_id = $2 AND amount < 0`,
                            [ack.po_id, req.bankBic]
                        );
                        // Add a positive TX for the refund (audit trail)
                        await client.query(
                            `INSERT INTO transactions (bank_id, amount, datetime, po_id, account_id, isvalid, iscomplete)
                             VALUES ($1, $2, $3, $4, $5, true, true)`,
                            [req.bankBic, amount, formatDatetime(new Date()), ack.po_id, ack.oa_id]
                        );
                    });
                    refunded++;
                    details.push({ po_id: ack.po_id, outcome: 'refunded', bb_code: bbCode });
                    await log(req.bankBic, LOG_TYPES.ACK_IN, `ACK FAIL po=${ack.po_id} bb_code=${bbCode} -> refunded ${ack.oa_id}`);
                } catch (refErr) {
                    details.push({ po_id: ack.po_id, outcome: 'refund_failed', error: refErr.message });
                    await log(req.bankBic, LOG_TYPES.EXCEPTION, `Refund failed po=${ack.po_id}: ${refErr.message}`);
                }
            }
        }

        return ok(res, {
            fetched: incoming.length,
            inserted: inserted.length,
            confirmed,
            refunded,
            details,
        }, `Processed ${valid.length} ACKs`);
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `ack_in_fetch failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message });
    }
});

// =====================================================================
// READ-ONLY views for admin GUI (and quick debugging)
// =====================================================================
router.get('/po_new',  async (req, res) => ok(res, await repo.listPoNew(req.bankBic)));
router.get('/po_out',  async (req, res) => ok(res, await repo.listPoOut(req.bankBic)));
router.get('/po_in',   async (req, res) => ok(res, await repo.listPoIn(req.bankBic)));
router.get('/ack_out', async (req, res) => ok(res, await repo.listAckOut(req.bankBic)));
router.get('/ack_in',  async (req, res) => ok(res, await repo.listAckIn(req.bankBic)));
router.get('/outstanding', async (req, res) => {
    const hours = req.query.hours != null ? Number(req.query.hours) : null;
    const rows = await repo.listOutstandingPoOut(req.bankBic, hours);
    return ok(res, rows, `${rows.length} outstanding`);
});

router.get('/transactions', async (req, res) => {
    const r = await query(
        `SELECT * FROM transactions WHERE bank_id = $1 ORDER BY datetime DESC LIMIT 200`,
        [req.bankBic]
    );
    return ok(res, r.rows);
});

router.get('/log', async (req, res) => {
    const r = await query(
        `SELECT * FROM log
          WHERE bank_id = $1 OR bank_id IS NULL
          ORDER BY datetime DESC
          LIMIT 500`,
        [req.bankBic]
    );
    return ok(res, r.rows);
});

// =====================================================================
// CB token diagnostics & helpers
// =====================================================================

// Force a fresh token (useful after token expired or for testing)
router.post('/cb/refresh_token', async (req, res) => {
    try {
        const token = await cb.generateToken(req.bankBic);
        return ok(res, { token: token.substring(0, 8) + '...', length: token.length }, 'token refreshed');
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: `CB token refresh failed: ${err.message}` });
    }
});

// List all banks registered at the CB (incl. our team and other teams)
router.get('/cb/banks', async (req, res) => {
    try {
        const r = await cb.cbListBanks(req.bankBic);
        return ok(res, r.body, `CB returned HTTP ${r.status}`);
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// Update OUR bank info at the CB (name + members)
// Body: { name: "...", members: "..." }
router.post('/cb/banks', async (req, res) => {
    try {
        const r = await cb.cbUpdateBank(req.bankBic, {
            name: req.body.name,
            members: req.body.members,
        });
        return ok(res, r.body, `CB returned HTTP ${r.status}`);
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// READ-ONLY peek at CB.PO_OUT (does NOT consume - safe for debugging)
router.get('/cb/po_out_peek', async (req, res) => {
    try {
        const r = await cb.cbPeekPoOut(req.bankBic);
        return ok(res, r.body, 'read-only preview from CB');
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// READ-ONLY peek at CB.ACK_OUT (does NOT consume)
router.get('/cb/ack_out_peek', async (req, res) => {
    try {
        const r = await cb.cbPeekAckOut(req.bankBic);
        return ok(res, r.body, 'read-only preview from CB');
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// CB error code reference (no auth needed)
router.get('/cb/errorcodes', async (req, res) => {
    try {
        const r = await cb.cbErrorCodes();
        return ok(res, r.body, `CB returned HTTP ${r.status}`);
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// CB global log (all teams - useful for debugging)
router.get('/cb/global_log', async (req, res) => {
    try {
        const r = await cb.cbGlobalLog(req.bankBic);
        return ok(res, r.body, `CB returned HTTP ${r.status}`);
    } catch (err) {
        return fail(res, { status: 502, code: OWN.CB_UPSTREAM_ERROR, message: err.message });
    }
});

// =====================================================================
// SELF-TEST: full SEPA cycle between our 2 banks via the real CB
// =====================================================================
//
// Generates 1 PO from current bank to the OTHER bank we manage,
// runs po_new_process (debits OA, sends to CB), then pulls back
// PO_IN as the receiving bank, processes it, then closes ACK_IN.
//
// USE ONLY for development - this exercises the destructive CB endpoints.
// =====================================================================
router.post('/test/full_cycle', async (req, res) => {
    const { banks: allBanks } = require('../config');
    const otherBank = allBanks.find(b => b.bic !== req.bankBic);
    if (!otherBank) {
        return fail(res, { status: 400, code: OWN.VALIDATION_FAILED, message: 'Need 2 managed banks for self-test' });
    }

    const trace = [];
    const log_step = (step, info) => trace.push({ step, ...info });

    try {
        // Step 1: pick OA from this bank, BA from other bank
        const oaR = await query(`SELECT id FROM accounts WHERE bank_id = $1 LIMIT 1`, [req.bankBic]);
        const baR = await query(`SELECT id FROM accounts WHERE bank_id = $1 LIMIT 1`, [otherBank.bic]);
        if (!oaR.rowCount || !baR.rowCount) {
            return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: 'No accounts in one of the banks' });
        }

        const { generatePOs } = require('../services/poGenerator');
        const [po] = await generatePOs(req.bankBic, 1, { errorRatio: 0, testRunName: 'self-test-full-cycle' });
        // Force it to go to the other managed bank
        po.oa_id = oaR.rows[0].id;
        po.bb_id = otherBank.bic;
        po.ba_id = baR.rows[0].id;
        po.po_amount = 1.00; // small fixed amount

        log_step('1_generated', { po });

        // Step 2: insert into PO_NEW of this bank
        await repo.insertPoNew([{ ...po, bank_id: req.bankBic }]);
        log_step('2_inserted_in_po_new', { po_id: po.po_id });

        // Step 3: process PO_NEW (validates, debits OA, sends to CB)
        const procRes = await fetch(`http://localhost:${require('../config').port}/api/po_new_process`, {
            method: 'GET',
            headers: {
                'Authorization': req.header('Authorization'),
                'X-Bank-BIC': req.bankBic,
            },
        });
        const procBody = await procRes.json();
        log_step('3_po_new_process', { status: procRes.status, body: procBody });

        // Step 4: as the OTHER bank, fetch PO_IN
        const fetchRes = await fetch(`http://localhost:${require('../config').port}/api/po_in_fetch`, {
            method: 'GET',
            headers: {
                'Authorization': req.header('Authorization'),
                'X-Bank-BIC': otherBank.bic,
            },
        });
        const fetchBody = await fetchRes.json();
        log_step('4_po_in_fetch', { status: fetchRes.status, body: fetchBody });

        // Step 5: as the OTHER bank, process PO_IN (book TX, send ACK_OUT)
        const procInRes = await fetch(`http://localhost:${require('../config').port}/api/po_in_process`, {
            method: 'GET',
            headers: {
                'Authorization': req.header('Authorization'),
                'X-Bank-BIC': otherBank.bic,
            },
        });
        const procInBody = await procInRes.json();
        log_step('5_po_in_process', { status: procInRes.status, body: procInBody });

        // Step 6: as ORIGINAL bank, fetch ACK_IN
        const ackRes = await fetch(`http://localhost:${require('../config').port}/api/ack_in_fetch`, {
            method: 'GET',
            headers: {
                'Authorization': req.header('Authorization'),
                'X-Bank-BIC': req.bankBic,
            },
        });
        const ackBody = await ackRes.json();
        log_step('6_ack_in_fetch', { status: ackRes.status, body: ackBody });

        return ok(res, { po_id: po.po_id, trace }, 'Full SEPA cycle executed');
    } catch (err) {
        await log(req.bankBic, LOG_TYPES.EXCEPTION, `full_cycle test failed: ${err.message}`);
        return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message, data: trace });
    }
});

module.exports = router;

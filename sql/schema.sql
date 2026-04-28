-- =====================================================================
-- PingFin Workshop - Regular Bank Schema (PostgreSQL)
-- Team 18 - Banks: BYBBBEBB and GOCFBEB2
-- =====================================================================
-- Naming: snake_case, lowercase. PO message fields per slide 16.
-- Strategy: bank_id column on every table to support 2 banks in 1 DB.
-- PO lifecycle: row MOVES between PO_NEW -> PO_OUT (no copy).
-- After PO_OUT, history kept (ACK_IN as new row, PO_OUT row stays).
-- =====================================================================

-- Drop in reverse-dependency order (idempotent for re-runs)
DROP TABLE IF EXISTS cb_tokens     CASCADE;
DROP TABLE IF EXISTS log           CASCADE;
DROP TABLE IF EXISTS transactions  CASCADE;
DROP TABLE IF EXISTS ack_out       CASCADE;
DROP TABLE IF EXISTS ack_in        CASCADE;
DROP TABLE IF EXISTS po_in         CASCADE;
DROP TABLE IF EXISTS po_out        CASCADE;
DROP TABLE IF EXISTS po_new        CASCADE;
DROP TABLE IF EXISTS accounts      CASCADE;

-- =====================================================================
-- ACCOUNTS (regular bank only)
-- One row per IBAN. bank_id ties account to one of our 2 banks.
-- =====================================================================
CREATE TABLE accounts (
    id          VARCHAR(34)    PRIMARY KEY,         -- IBAN, no spaces
    bank_id     VARCHAR(11)    NOT NULL,            -- BIC of owning bank
    balance     DECIMAL(12, 2) NOT NULL DEFAULT 0,  -- current balance
    CONSTRAINT  accounts_balance_nonneg CHECK (balance >= 0)
);
CREATE INDEX idx_accounts_bank ON accounts(bank_id);

-- =====================================================================
-- PO_NEW - newly generated PO's, awaiting OB validation/processing
-- Source: /api/po_new_add or /api/po_new_generate
-- Most CB/BB fields nullable (slide 19 group 1)
-- =====================================================================
CREATE TABLE po_new (
    po_id        VARCHAR(50)    PRIMARY KEY,
    bank_id      VARCHAR(11)    NOT NULL,           -- which of our 2 banks owns this row (= ob_id)
    po_amount    DECIMAL(12, 2) NOT NULL,
    po_message   VARCHAR(500)   NOT NULL,
    po_datetime  TIMESTAMP      NOT NULL,
    ob_id        VARCHAR(11)    NOT NULL,
    oa_id        VARCHAR(34)    NOT NULL,
    ob_code      INT            NULL,
    ob_datetime  TIMESTAMP      NULL,
    cb_code      INT            NULL,
    cb_datetime  TIMESTAMP      NULL,
    bb_id        VARCHAR(11)    NULL,
    ba_id        VARCHAR(34)    NULL,
    bb_code      INT            NULL,
    bb_datetime  TIMESTAMP      NULL
);
CREATE INDEX idx_po_new_bank     ON po_new(bank_id);
CREATE INDEX idx_po_new_datetime ON po_new(po_datetime);

-- =====================================================================
-- PO_OUT - PO's passed OB validation, sent to CB. Awaiting ACK.
-- Used to detect outstanding payments (no matching row in ack_in).
-- =====================================================================
CREATE TABLE po_out (
    po_id        VARCHAR(50)    PRIMARY KEY,
    bank_id      VARCHAR(11)    NOT NULL,           -- = ob_id (we are OB here)
    po_amount    DECIMAL(12, 2) NOT NULL,
    po_message   VARCHAR(500)   NOT NULL,
    po_datetime  TIMESTAMP      NOT NULL,
    ob_id        VARCHAR(11)    NOT NULL,
    oa_id        VARCHAR(34)    NOT NULL,
    ob_code      INT            NOT NULL,
    ob_datetime  TIMESTAMP      NOT NULL,
    cb_code      INT            NULL,
    cb_datetime  TIMESTAMP      NULL,
    bb_id        VARCHAR(11)    NOT NULL,
    ba_id        VARCHAR(34)    NOT NULL,
    bb_code      INT            NULL,
    bb_datetime  TIMESTAMP      NULL
);
CREATE INDEX idx_po_out_bank        ON po_out(bank_id);
CREATE INDEX idx_po_out_ob_datetime ON po_out(ob_datetime);

-- =====================================================================
-- PO_IN - PO's fetched from CB.PO_OUT where we are BB
-- We need to validate them and either accept (book TX) or reject.
-- =====================================================================
CREATE TABLE po_in (
    po_id        VARCHAR(50)    PRIMARY KEY,
    bank_id      VARCHAR(11)    NOT NULL,           -- = bb_id (we are BB here)
    po_amount    DECIMAL(12, 2) NOT NULL,
    po_message   VARCHAR(500)   NOT NULL,
    po_datetime  TIMESTAMP      NOT NULL,
    ob_id        VARCHAR(11)    NOT NULL,
    oa_id        VARCHAR(34)    NOT NULL,
    ob_code      INT            NOT NULL,
    ob_datetime  TIMESTAMP      NOT NULL,
    cb_code      INT            NOT NULL,
    cb_datetime  TIMESTAMP      NOT NULL,
    bb_id        VARCHAR(11)    NOT NULL,
    ba_id        VARCHAR(34)    NOT NULL,
    bb_code      INT            NULL,
    bb_datetime  TIMESTAMP      NULL
);
CREATE INDEX idx_po_in_bank ON po_in(bank_id);

-- =====================================================================
-- ACK_OUT - ACK's we (as BB) created, ready to push to CB.ACK_IN
-- =====================================================================
CREATE TABLE ack_out (
    po_id        VARCHAR(50)    PRIMARY KEY,
    bank_id      VARCHAR(11)    NOT NULL,           -- = bb_id
    po_amount    DECIMAL(12, 2) NOT NULL,
    po_message   VARCHAR(500)   NOT NULL,
    po_datetime  TIMESTAMP      NOT NULL,
    ob_id        VARCHAR(11)    NOT NULL,
    oa_id        VARCHAR(34)    NOT NULL,
    ob_code      INT            NOT NULL,
    ob_datetime  TIMESTAMP      NOT NULL,
    cb_code      INT            NOT NULL,
    cb_datetime  TIMESTAMP      NOT NULL,
    bb_id        VARCHAR(11)    NOT NULL,
    ba_id        VARCHAR(34)    NOT NULL,
    bb_code      INT            NOT NULL,
    bb_datetime  TIMESTAMP      NOT NULL
);
CREATE INDEX idx_ack_out_bank ON ack_out(bank_id);

-- =====================================================================
-- ACK_IN - ACK's we received from CB.ACK_OUT (about PO's we sent as OB)
-- Used to close out po_out entries.
-- =====================================================================
CREATE TABLE ack_in (
    po_id        VARCHAR(50)    PRIMARY KEY,
    bank_id      VARCHAR(11)    NOT NULL,           -- = ob_id
    po_amount    DECIMAL(12, 2) NOT NULL,
    po_message   VARCHAR(500)   NOT NULL,
    po_datetime  TIMESTAMP      NOT NULL,
    ob_id        VARCHAR(11)    NOT NULL,
    oa_id        VARCHAR(34)    NOT NULL,
    ob_code      INT            NOT NULL,
    ob_datetime  TIMESTAMP      NOT NULL,
    cb_code      INT            NOT NULL,
    cb_datetime  TIMESTAMP      NOT NULL,
    bb_id        VARCHAR(11)    NOT NULL,
    ba_id        VARCHAR(34)    NOT NULL,
    bb_code      INT            NOT NULL,
    bb_datetime  TIMESTAMP      NOT NULL
);
CREATE INDEX idx_ack_in_bank ON ack_in(bank_id);

-- =====================================================================
-- TRANSACTIONS (regular bank only)
-- Only for ACTUALLY booked transactions (failures go to LOG, not here).
-- amount: NEGATIVE on OA (debit), POSITIVE on BA (credit).
-- =====================================================================
CREATE TABLE transactions (
    id          SERIAL         PRIMARY KEY,
    bank_id     VARCHAR(11)    NOT NULL,
    amount      DECIMAL(12, 2) NOT NULL,
    datetime    TIMESTAMP      NOT NULL,
    po_id       VARCHAR(50)    NOT NULL,
    account_id  VARCHAR(34)    NOT NULL REFERENCES accounts(id),
    isvalid     BOOLEAN        NOT NULL DEFAULT TRUE,
    iscomplete  BOOLEAN        NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_tx_bank    ON transactions(bank_id);
CREATE INDEX idx_tx_po_id   ON transactions(po_id);
CREATE INDEX idx_tx_account ON transactions(account_id);

-- =====================================================================
-- LOG (both bank types)
-- Catch-all for events, exceptions, incoming/outgoing messages.
-- =====================================================================
CREATE TABLE log (
    id        SERIAL       PRIMARY KEY,
    bank_id   VARCHAR(11)  NULL,                    -- NULL allowed for system-level logs
    datetime  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    type      VARCHAR(50)  NOT NULL,                -- e.g. general, ack_in, po_out, exception
    message   TEXT         NOT NULL
);
CREATE INDEX idx_log_bank     ON log(bank_id);
CREATE INDEX idx_log_datetime ON log(datetime);
CREATE INDEX idx_log_type     ON log(type);

-- =====================================================================
-- CB_TOKENS - cache for clearing-bank bearer tokens (4h validity)
-- Avoids re-generating a token on every CB call.
-- =====================================================================
CREATE TABLE cb_tokens (
    bank_id     VARCHAR(11) PRIMARY KEY,            -- our bank's BIC
    token       TEXT        NOT NULL,
    expires_at  TIMESTAMP   NOT NULL,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================================
-- SEED DATA: 20 accounts per bank, each with 5000 EUR (slide 8)
-- IBAN format: BE + 2 check digits + 12 digit BBAN
-- (Synthetic - check digits not validated mod-97 here, only format)
-- =====================================================================
-- 20 accounts for BYBBBEBB
INSERT INTO accounts (id, bank_id, balance) VALUES
('BE68539007547001', 'BYBBBEBB', 5000.00),
('BE68539007547002', 'BYBBBEBB', 5000.00),
('BE68539007547003', 'BYBBBEBB', 5000.00),
('BE68539007547004', 'BYBBBEBB', 5000.00),
('BE68539007547005', 'BYBBBEBB', 5000.00),
('BE68539007547006', 'BYBBBEBB', 5000.00),
('BE68539007547007', 'BYBBBEBB', 5000.00),
('BE68539007547008', 'BYBBBEBB', 5000.00),
('BE68539007547009', 'BYBBBEBB', 5000.00),
('BE68539007547010', 'BYBBBEBB', 5000.00),
('BE68539007547011', 'BYBBBEBB', 5000.00),
('BE68539007547012', 'BYBBBEBB', 5000.00),
('BE68539007547013', 'BYBBBEBB', 5000.00),
('BE68539007547014', 'BYBBBEBB', 5000.00),
('BE68539007547015', 'BYBBBEBB', 5000.00),
('BE68539007547016', 'BYBBBEBB', 5000.00),
('BE68539007547017', 'BYBBBEBB', 5000.00),
('BE68539007547018', 'BYBBBEBB', 5000.00),
('BE68539007547019', 'BYBBBEBB', 5000.00),
('BE68539007547020', 'BYBBBEBB', 5000.00);

-- 20 accounts for GOCFBEB2
INSERT INTO accounts (id, bank_id, balance) VALUES
('BE71096123456701', 'GOCFBEB2', 5000.00),
('BE71096123456702', 'GOCFBEB2', 5000.00),
('BE71096123456703', 'GOCFBEB2', 5000.00),
('BE71096123456704', 'GOCFBEB2', 5000.00),
('BE71096123456705', 'GOCFBEB2', 5000.00),
('BE71096123456706', 'GOCFBEB2', 5000.00),
('BE71096123456707', 'GOCFBEB2', 5000.00),
('BE71096123456708', 'GOCFBEB2', 5000.00),
('BE71096123456709', 'GOCFBEB2', 5000.00),
('BE71096123456710', 'GOCFBEB2', 5000.00),
('BE71096123456711', 'GOCFBEB2', 5000.00),
('BE71096123456712', 'GOCFBEB2', 5000.00),
('BE71096123456713', 'GOCFBEB2', 5000.00),
('BE71096123456714', 'GOCFBEB2', 5000.00),
('BE71096123456715', 'GOCFBEB2', 5000.00),
('BE71096123456716', 'GOCFBEB2', 5000.00),
('BE71096123456717', 'GOCFBEB2', 5000.00),
('BE71096123456718', 'GOCFBEB2', 5000.00),
('BE71096123456719', 'GOCFBEB2', 5000.00),
('BE71096123456720', 'GOCFBEB2', 5000.00);

-- Init log entry
INSERT INTO log (bank_id, type, message) VALUES
(NULL, 'system', 'Database schema initialized for team 18 (BYBBBEBB + GOCFBEB2)');

// src/server.js
// PingFin team 18 - regular bank API entry point.

const express = require('express');
const path    = require('path');
const config  = require('./config');
const { log, LOG_TYPES } = require('./services/logger');
const { fail } = require('./utils/response');
const { OWN } = require('./utils/errorCodes');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve the GUI from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// Tiny request logger -> log table
app.use(async (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        const bic = req.header('X-Bank-BIC') || req.query.bank || null;
        log(bic, LOG_TYPES.API_IN, `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`).catch(() => {});
    });
    next();
});

// Routes
app.use('/api', require('./routes/public'));
app.use('/api', require('./routes/internal'));

// Health check (no auth, no bank context)
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// 404
app.use((req, res) => {
    return fail(res, { status: 404, code: OWN.NOT_FOUND, message: `not found: ${req.method} ${req.originalUrl}` });
});

// Error handler
app.use((err, req, res, _next) => {
    console.error('[server] unhandled:', err);
    return fail(res, { status: 500, code: OWN.INTERNAL_ERROR, message: err.message || 'internal error' });
});

app.listen(config.port, async () => {
    console.log(`PingFin team 18 listening on http://localhost:${config.port}`);
    console.log(`Banks: ${config.banks.map(b => b.bic).join(', ')}`);

    // Auto-register both banks at the CB (slide 27 API 3).
    // Don't block startup if it fails - just log.
    if (process.env.AUTO_REGISTER !== 'false') {
        try {
            const { autoRegister } = require('./services/bootstrap');
            await autoRegister();
        } catch (e) {
            console.warn('[bootstrap] failed:', e.message);
        }
    }
});

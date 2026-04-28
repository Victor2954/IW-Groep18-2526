// ============================================================
// PingFin Admin GUI - Team 18
// Vanilla JS, no framework, no build step
// ============================================================

const API = '/api';
const POLL_INTERVAL = 4000;  // ms

// ----------------- State -----------------
const state = {
    token:   localStorage.getItem('pingfin_admin_token') || null,
    bank:    localStorage.getItem('pingfin_active_bank') || 'BYBBBEBB',
    autoLog: true,
    pollers: [],
};

// ============================================================
// AUTH / LOGIN
// ============================================================
const overlay = document.getElementById('login-overlay');
const loginInput = document.getElementById('login-token');
const loginErr = document.getElementById('login-error');

function showLogin() {
    overlay.classList.remove('hidden');
    loginInput.value = '';
    setTimeout(() => loginInput.focus(), 100);
}

function hideLogin() {
    overlay.classList.add('hidden');
}

async function tryLogin(token) {
    loginErr.textContent = '';
    if (!token) {
        loginErr.textContent = 'Voer een token in.';
        return false;
    }

    try {
        const r = await fetch(`${API}/info?bank=${state.bank}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (r.status === 401) {
            loginErr.textContent = 'Token afgewezen.';
            return false;
        }
        // /api/info doesn't require admin auth, so try one that does
        const r2 = await fetch(`${API}/log?bank=${state.bank}`, {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (r2.status === 401) {
            loginErr.textContent = 'Token afgewezen (admin).';
            return false;
        }
        if (!r2.ok) {
            loginErr.textContent = `Server error: HTTP ${r2.status}`;
            return false;
        }
        return true;
    } catch (e) {
        loginErr.textContent = `Netwerkfout: ${e.message}`;
        return false;
    }
}

document.getElementById('login-submit').addEventListener('click', async () => {
    const token = loginInput.value.trim();
    const ok = await tryLogin(token);
    if (ok) {
        state.token = token;
        localStorage.setItem('pingfin_admin_token', token);
        hideLogin();
        boot();
    }
});

loginInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('login-submit').click();
});

document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('pingfin_admin_token');
    state.token = null;
    stopPolling();
    showLogin();
});

// ============================================================
// API HELPERS
// ============================================================
async function apiGet(path, opts = {}) {
    return apiCall('GET', path, null, opts);
}

async function apiPost(path, body, opts = {}) {
    return apiCall('POST', path, body, opts);
}

async function apiCall(method, path, body, { silent = false } = {}) {
    const headers = {
        'Authorization': `Bearer ${state.token}`,
        'X-Bank-BIC':    state.bank,
    };
    const opts = { method, headers };
    if (body != null) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    try {
        const r = await fetch(`${API}${path}`, opts);
        const json = await r.json();

        if (r.status === 401) {
            // Token rejected -> force re-login
            stopPolling();
            showLogin();
            loginErr.textContent = 'Sessie verlopen. Login opnieuw.';
            throw new Error('unauthorized');
        }

        if (!silent) {
            updateRefreshTime();
        }
        return { http: r.status, ...json };
    } catch (e) {
        if (e.message !== 'unauthorized') {
            console.error(`[api] ${method} ${path} failed:`, e);
        }
        throw e;
    }
}

function updateRefreshTime() {
    const t = new Date().toLocaleTimeString('nl-BE', { hour12: false });
    document.querySelector('#last-refresh em').textContent = t;
}

// ============================================================
// BANK SWITCHER
// ============================================================
function setActiveBank(bic) {
    const previous = state.bank;
    state.bank = bic;
    localStorage.setItem('pingfin_active_bank', bic);
    document.querySelectorAll('.bank-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.bic === bic);
    });
    // Reset transfer form fields that depend on active bank
    if (previous !== bic) {
        document.getElementById('tf-bb').value = bic;
        document.getElementById('tf-ba').value = '';
        document.getElementById('tf-amount').value = '';
        document.getElementById('tf-message').value = '';
        document.getElementById('tf-result').className = 'form-result';
        document.getElementById('tf-result').textContent = '';
    }
    refreshAll();
}

document.querySelectorAll('.bank-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveBank(btn.dataset.bic));
});

// ============================================================
// ACCOUNTS
// ============================================================
async function loadAccounts() {
    try {
        const r = await apiGet('/accounts', { silent: true });
        renderAccounts(r.data || []);
        populateOaSelect(r.data || []);
    } catch (e) { /* handled */ }
}

function renderAccounts(rows) {
    const el = document.getElementById('accounts-table');
    if (rows.length === 0) {
        el.innerHTML = '<div class="empty">no accounts</div>';
        return;
    }
    let html = '<table><thead><tr><th>IBAN</th><th class="num">Balance</th></tr></thead><tbody>';
    let total = 0;
    for (const r of rows) {
        const bal = Number(r.balance);
        total += bal;
        html += `<tr><td>${escapeHtml(r.id)}</td><td class="num">${formatEur(bal)}</td></tr>`;
    }
    html += `<tr style="border-top:2px solid var(--border)"><td><strong>Total</strong></td><td class="num"><strong>${formatEur(total)}</strong></td></tr>`;
    html += '</tbody></table>';
    el.innerHTML = html;
}

function populateOaSelect(rows) {
    const sel = document.getElementById('tf-oa');
    const current = sel.value;
    sel.innerHTML = '';
    const validIds = [];
    for (const r of rows) {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = `${r.id}  €${Number(r.balance).toFixed(2)}`;
        sel.appendChild(opt);
        validIds.push(r.id);
    }
    if (current && validIds.includes(current)) {
        sel.value = current;
    } else if (validIds.length > 0) {
        sel.value = validIds[0];
    }
}

// ============================================================
// FLOW TABLES (po_new, po_out, po_in, ack_in, ack_out, transactions)
// ============================================================
async function loadTable(name) {
    const path = name === 'transactions' ? '/transactions' : `/${name}`;
    try {
        const r = await apiGet(path, { silent: true });
        renderFlowTable(name, r.data || []);
    } catch (e) { /* handled */ }
}

function renderFlowTable(name, rows) {
    const el = document.getElementById(`${name}-table`);
    if (!rows || rows.length === 0) {
        el.innerHTML = '<div class="empty">empty</div>';
        return;
    }

    if (name === 'transactions') {
        el.innerHTML = renderTxTable(rows.slice(0, 50));
        return;
    }

    // PO-style tables
    let html = '<table><thead><tr>'
        + '<th>po_id</th><th class="num">amount</th>'
        + '<th>OB</th><th>OA</th>'
        + '<th>BB</th><th>BA</th>'
        + '<th>OB code</th><th>CB code</th><th>BB code</th>'
        + '<th>datetime</th>'
        + '</tr></thead><tbody>';
    for (const r of rows) {
        html += '<tr>'
            + `<td title="${escapeHtml(r.po_id)}">${truncate(r.po_id, 18)}</td>`
            + `<td class="num">${formatEur(r.po_amount)}</td>`
            + `<td>${escapeHtml(r.ob_id || '')}</td>`
            + `<td title="${escapeHtml(r.oa_id || '')}">${truncate(r.oa_id, 14)}</td>`
            + `<td>${escapeHtml(r.bb_id || '—')}</td>`
            + `<td title="${escapeHtml(r.ba_id || '')}">${truncate(r.ba_id, 14)}</td>`
            + `<td>${codeTag(r.ob_code)}</td>`
            + `<td>${codeTag(r.cb_code)}</td>`
            + `<td>${codeTag(r.bb_code)}</td>`
            + `<td>${escapeHtml(formatDt(r.po_datetime))}</td>`
            + '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
}

function renderTxTable(rows) {
    let html = '<table><thead><tr>'
        + '<th>id</th><th>account</th><th class="num">amount</th>'
        + '<th>po_id</th><th>valid</th><th>complete</th><th>datetime</th>'
        + '</tr></thead><tbody>';
    for (const r of rows) {
        const amt = Number(r.amount);
        html += '<tr>'
            + `<td>${r.id}</td>`
            + `<td title="${escapeHtml(r.account_id)}">${truncate(r.account_id, 14)}</td>`
            + `<td class="num ${amt < 0 ? 'neg' : 'pos'}">${formatEur(amt)}</td>`
            + `<td title="${escapeHtml(r.po_id)}">${truncate(r.po_id, 14)}</td>`
            + `<td><span class="bool-tag ${r.isvalid ? 't' : 'f'}">${r.isvalid ? '✓' : '✗'}</span></td>`
            + `<td><span class="bool-tag ${r.iscomplete ? 't' : 'f'}">${r.iscomplete ? '✓' : '✗'}</span></td>`
            + `<td>${escapeHtml(formatDt(r.datetime))}</td>`
            + '</tr>';
    }
    html += '</tbody></table>';
    return html;
}

function codeTag(code) {
    if (code == null) return '<span class="muted">—</span>';
    const n = Number(code);
    if (n === 2000) return `<span class="code-tag code-ok">${n}</span>`;
    if (n >= 4001 && n < 5000) return `<span class="code-tag code-fail">${n}</span>`;
    return `<span class="code-tag code-pending">${n}</span>`;
}

// ============================================================
// LOG STREAM
// ============================================================
async function loadLog() {
    try {
        const r = await apiGet('/log', { silent: true });
        renderLog(r.data || []);
    } catch (e) { /* handled */ }
}

function renderLog(rows) {
    const el = document.getElementById('log-stream');
    el.innerHTML = '';
    for (const r of rows.slice(0, 100)) {
        const div = document.createElement('div');
        div.className = `log-entry t-${(r.type || 'general').toLowerCase()}`;
        div.innerHTML =
            `<span class="log-time">${formatDt(r.datetime).split(' ')[1] || ''}</span>` +
            `<span class="log-type">${escapeHtml(r.type)}</span>` +
            `<span class="log-msg">${escapeHtml(r.message)}</span>`;
        el.appendChild(div);
    }
}

// ============================================================
// TRANSFER FORM
// ============================================================
const tfForm    = document.getElementById('transfer-form');
const tfResult  = document.getElementById('tf-result');
const tfBb      = document.getElementById('tf-bb');

// Pre-fill bb to active bank initially
function prefillTransfer() {
    if (!tfBb.value) tfBb.value = state.bank;
}

tfForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitTransfer(false);
});

document.getElementById('tf-process-after').addEventListener('click', async () => {
    await submitTransfer(true);
});

async function submitTransfer(processAfter) {
    tfResult.className = 'form-result';
    tfResult.textContent = '';

    const oa = document.getElementById('tf-oa').value;
    const bb = tfBb.value.trim().toUpperCase();
    const ba = document.getElementById('tf-ba').value.trim();
    const amount = parseFloat(document.getElementById('tf-amount').value);
    const message = document.getElementById('tf-message').value.trim();

    if (!oa || !bb || !ba || !amount || !message) {
        tfResult.className = 'form-result error';
        tfResult.textContent = 'Vul alle velden in.';
        return;
    }

    const oaSelect = document.getElementById('tf-oa');
    const oaOptions = Array.from(oaSelect.options).map(o => o.value);
    if (!oaOptions.includes(oa)) {
        tfResult.className = 'form-result error';
        tfResult.textContent = `OA ${oa} hoort niet bij actieve bank ${state.bank}. Switch eerst van bank.`;
        return;
    }

    const po_id = `${state.bank}_${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
    const po = {
        po_id,
        po_amount:   amount,
        po_message:  message,
        po_datetime: formatNow(),
        ob_id:       state.bank,
        oa_id:       oa,
        bb_id:       bb,
        ba_id:       ba,
    };

    try {
        const r = await apiPost('/po_new_add', { data: [po] });
        if (!r.ok) {
            tfResult.className = 'form-result error';
            tfResult.textContent = `Fout: ${r.message || r.code}`;
            return;
        }
        tfResult.className = 'form-result success';
        tfResult.textContent = `PO ${truncate(po_id, 25)} toegevoegd aan PO_NEW.`;
        showActionResult(r);

        if (processAfter) {
            const procRes = await apiGet('/po_new_process');
            showActionResult(procRes);

            const detail = (procRes.data?.details || []).find(d => d.po_id === po_id);
            if (detail) {
                if (detail.outcome === 'invalid' || detail.outcome === 'error') {
                    tfResult.className = 'form-result error';
                    tfResult.textContent = `INVALID: ${detail.message || 'code ' + detail.code} - saldo NIET aangepast.`;
                } else if (detail.outcome === 'internal_booked') {
                    tfResult.className = 'form-result success';
                    tfResult.textContent = `Interne payment geboekt - saldo's bijgewerkt.`;
                } else if (detail.outcome === 'moved_to_po_out_and_debited') {
                    tfResult.className = 'form-result success';
                    tfResult.textContent = `Naar CB verstuurd, OA gedebiteerd. Wacht op ACK.`;
                } else {
                    tfResult.className = 'form-result success';
                    tfResult.textContent = `Outcome: ${detail.outcome}`;
                }
            }
        }
        refreshAll();
    } catch (e) {
        tfResult.className = 'form-result error';
        tfResult.textContent = `Netwerkfout: ${e.message}`;
    }
}

// ============================================================
// QUICK GENERATOR
// ============================================================
document.getElementById('gen-btn').addEventListener('click', async () => {
    const count = parseInt(document.getElementById('gen-count').value, 10) || 5;
    try {
        const r = await apiPost('/po_new_add', { generate: count });
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
});

// ============================================================
// FLOW ACTIONS
// ============================================================
async function processNew() {
    setActionsBusy(true);
    try {
        const r = await apiGet('/po_new_process');
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
    setActionsBusy(false);
}

async function fetchPoIn() {
    setActionsBusy(true);
    try {
        const r = await apiGet('/po_in_fetch');
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
    setActionsBusy(false);
}

async function processPoIn() {
    setActionsBusy(true);
    try {
        const r = await apiGet('/po_in_process');
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
    setActionsBusy(false);
}

async function fetchAckIn() {
    setActionsBusy(true);
    try {
        const r = await apiGet('/ack_in_fetch');
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
    setActionsBusy(false);
}

async function fullCycle() {
    if (!confirm('Run full self-test cycle? This will generate, send, fetch and ACK a real PO via the CB.')) return;
    setActionsBusy(true);
    try {
        const r = await apiPost('/test/full_cycle', {});
        showActionResult(r);
        refreshAll();
    } catch (e) { /* handled */ }
    setActionsBusy(false);
}

document.getElementById('btn-process-new').addEventListener('click', processNew);
document.getElementById('btn-fetch-poin').addEventListener('click', fetchPoIn);
document.getElementById('btn-process-poin').addEventListener('click', processPoIn);
document.getElementById('btn-fetch-ackin').addEventListener('click', fetchAckIn);
document.getElementById('btn-fullcycle').addEventListener('click', fullCycle);

function setActionsBusy(busy) {
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = busy);
}

// ============================================================
// ACTION RESULT VIEWER
// ============================================================
function showActionResult(obj) {
    const el = document.getElementById('action-result');
    el.innerHTML = colorJson(obj);
}

function colorJson(obj) {
    const txt = JSON.stringify(obj, null, 2);
    return escapeHtml(txt)
        .replace(/("(?:[^"\\]|\\.)*")\s*:/g, '<span class="key">$1</span>:')
        .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="str">$1</span>')
        .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="num">$1</span>')
        .replace(/:\s*(true|false)/g, ': <span class="bool">$1</span>')
        .replace(/:\s*(null)/g, ': <span class="null">$1</span>');
}

document.getElementById('clear-result').addEventListener('click', () => {
    document.getElementById('action-result').textContent = 'cleared';
});

// ============================================================
// REFRESH BUTTONS (per panel)
// ============================================================
document.querySelectorAll('.refresh-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        if (target === 'accounts') loadAccounts();
        else if (target === 'log') loadLog();
        else loadTable(target);
    });
});

// ============================================================
// AUTO-LOG TOGGLE
// ============================================================
document.getElementById('auto-refresh-log').addEventListener('change', (e) => {
    state.autoLog = e.target.checked;
});

// ============================================================
// CB STATUS CHECK
// ============================================================
async function checkCbStatus() {
    const el = document.getElementById('cb-status');
    try {
        const r = await apiGet('/cb/banks', { silent: true });
        if (r.ok) {
            const count = Array.isArray(r.data?.data) ? r.data.data.length : '?';
            el.className = 'status ok';
            el.querySelector('em').textContent = `online (${count} banks)`;
        } else {
            el.className = 'status error';
            el.querySelector('em').textContent = `error (${r.http})`;
        }
    } catch {
        el.className = 'status error';
        el.querySelector('em').textContent = 'unreachable';
    }
}

// ============================================================
// REFRESH ORCHESTRATION
// ============================================================
function refreshAll() {
    loadAccounts();
    loadTable('po_new');
    loadTable('po_out');
    loadTable('po_in');
    loadTable('ack_in');
    loadTable('ack_out');
    loadTable('transactions');
    if (state.autoLog) loadLog();
}

function startPolling() {
    stopPolling();
    state.pollers.push(setInterval(() => {
        if (state.autoLog) loadLog();
    }, POLL_INTERVAL));
    state.pollers.push(setInterval(checkCbStatus, 30_000));
    state.pollers.push(setInterval(() => {
        loadAccounts();
        loadTable('po_new');
        loadTable('po_out');
        loadTable('po_in');
        loadTable('ack_in');
    }, POLL_INTERVAL * 2));
}

function stopPolling() {
    state.pollers.forEach(p => clearInterval(p));
    state.pollers = [];
}

// ============================================================
// HELPERS
// ============================================================
function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.substring(0, n - 1) + '…' : s;
}

function formatEur(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('nl-BE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDt(s) {
    if (!s) return '';
    // Postgres returns ISO-like; show YYYY-MM-DD HH:MM:SS
    return String(s).replace('T', ' ').replace(/\.\d+Z?$/, '').substring(0, 19);
}

function formatNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// ============================================================
// BOOT
// ============================================================
function boot() {
    setActiveBank(state.bank);  // applies the active class to the right button + triggers refreshAll
    prefillTransfer();
    checkCbStatus();
    startPolling();
}

// On page load: either show login or boot
if (state.token) {
    // Verify the saved token still works before booting
    tryLogin(state.token).then(ok => {
        if (ok) {
            hideLogin();
            boot();
        } else {
            state.token = null;
            localStorage.removeItem('pingfin_admin_token');
            showLogin();
        }
    });
} else {
    showLogin();
}

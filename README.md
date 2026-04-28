# PingFin Team 18 - Bank Backend

Workshop project voor PingFin (SEPA-simulatie).
Team 18 beheert **2 banken**:
- `BYBBBEBB`
- `GOCFBEB2`

Stack: Node.js + Express + PostgreSQL (Railway).
Clearing bank: <https://stevenop.be/pingfin/api/v2> (geverifieerd via `/help`).

---

## Snel starten

### 1. Dependencies
```bash
npm install
```

### 2. Environment file
```bash
cp .env.example .env
```

Vul `.env` in:
- `DATABASE_URL` -> Railway PostgreSQL URL
- `BANK1_SECRET` -> `5b673750915dfc65`
- `BANK2_SECRET` -> `1e05a43b49722a9e`
- `ADMIN_TOKENS` -> bv `dev-admin-token-abc123`

> **NOOIT** `.env` committen.

### 3. Database
```bash
npm run db:init
```

### 4. Server
```bash
npm run dev
```

Open vervolgens `http://localhost:3000` in je browser. De GUI vraagt om je `ADMIN_TOKEN` (uit `.env`).

---

## Admin GUI

De GUI draait op `http://localhost:3000/` en wordt door dezelfde Express server geserveerd als de API.

**Functionaliteit:**
- **Login** met admin token (opgeslagen in localStorage)
- **Bank-switcher** boven (BYBBBEBB ↔ GOCFBEB2)
- **Accounts** panel met IBAN's, saldo's en totaal
- **Transfer** formulier voor handmatige PO's (intern of extern)
- **Quick generator** voor random testbatches
- **Flow tabellen** (PO_NEW, PO_OUT, PO_IN, ACK_IN, ACK_OUT, Transactions)
- **Action knoppen**: Process PO_NEW · Fetch PO_IN · Process PO_IN · Fetch ACK_IN · Full Cycle Test
- **Live log stream** met auto-refresh elke 4 seconden
- **Last action result** als gekleurde JSON viewer

Stack: vanilla HTML + JS, geen build step.

---

## CB API (geverifieerd, april 2026)

| Pad | Methode | Auth | Doel |
|---|---|---|---|
| `/token` | POST | nee | Token genereren (4u). Body: `{bic, secret_key}`. Response: `{ok, status, token}` |
| `/banks` | GET | bearer | Lijst alle banken |
| `/banks` | POST | bearer | Update onze eigen bank info |
| `/po_in` | POST | bearer | OB stuurt PO's naar CB |
| `/po_out` | GET | bearer | **DESTRUCTIEF!** verwijdert items uit queue |
| `/po_out/test/true` | GET | bearer | Read-only preview |
| `/ack_in` | POST | bearer | BB stuurt ACK's naar CB |
| `/ack_out` | GET | bearer | **DESTRUCTIEF** |
| `/ack_out/test/true` | GET | bearer | Read-only preview |
| `/errorcodes` | GET | nee | Officiële foutcodes |
| `/stats/type/log` | GET | bearer | Globale log van alle teams |

⚠️ Alle paden **zonder trailing slash**.

---

## Onze API

Responses volgen slide 22:
```json
{ "ok": true, "status": 200, "code": 2000, "message": "...", "data": ... }
```

### Bank context
- header `X-Bank-BIC: BYBBBEBB`, of
- query `?bank=BYBBBEBB`

### Admin auth
```
Authorization: Bearer <ADMIN_TOKENS waarde>
```

### Publieke endpoints (slide 21)
| Methode | Pad | Auth |
|---|---|---|
| GET | `/api/help` | geen |
| GET | `/api/info?bank=BYBBBEBB` | bank |
| GET | `/api/accounts?bank=BYBBBEBB` | bank |

### Interne endpoints

**PO-flow:**
| Methode | Pad | Doel |
|---|---|---|
| GET | `/api/po_new_generate?count=10` | preview random PO's |
| POST | `/api/po_new_add` | `{ data: [...] }` of `{ generate: 10 }` |
| GET | `/api/po_new_process` | OB-flow: valideren + intern→TX of extern→PO_OUT→CB |

**Read-only views:**
`/api/po_new`, `/api/po_out`, `/api/po_in`, `/api/ack_in`, `/api/ack_out`, `/api/outstanding`, `/api/transactions`, `/api/log`

**CB diagnostics:**
| Methode | Pad | Doel |
|---|---|---|
| POST | `/api/cb/refresh_token` | nieuwe CB token |
| GET | `/api/cb/banks` | banken lijst |
| POST | `/api/cb/banks` | update onze info |
| GET | `/api/cb/po_out_peek` | safe preview |
| GET | `/api/cb/ack_out_peek` | safe preview |
| GET | `/api/cb/errorcodes` | CB foutcodes |
| GET | `/api/cb/global_log` | globale log |

---

## Voorbeelden (cURL)

### Token testen
```bash
curl -X POST \
  -H "Authorization: Bearer dev-admin-token-abc123" \
  -H "X-Bank-BIC: BYBBBEBB" \
  http://localhost:3000/api/cb/refresh_token
```

### Onze info pushen
```bash
curl -X POST \
  -H "Authorization: Bearer dev-admin-token-abc123" \
  -H "X-Bank-BIC: BYBBBEBB" \
  -H "Content-Type: application/json" \
  -d '{"name":"Bank Yvonne","members":"Mesut, ...; HER 3-5306"}' \
  http://localhost:3000/api/cb/banks
```

### 10 PO's genereren + verwerken
```bash
curl -X POST -H "Authorization: Bearer dev-admin-token-abc123" \
  -H "X-Bank-BIC: BYBBBEBB" -H "Content-Type: application/json" \
  -d '{"generate": 10}' \
  http://localhost:3000/api/po_new_add

curl -H "Authorization: Bearer dev-admin-token-abc123" \
     -H "X-Bank-BIC: BYBBBEBB" \
     http://localhost:3000/api/po_new_process
```

---

## Foutcodes

### Officiële CB codes
| Code | ec_code | Betekenis |
|---|---|---|
| 2000 | ok | OK |
| 4001 | ecb001 | Internal TX, mag niet naar CB |
| 4002 | ecb002 | bedrag > 500 |
| 4003 | ecb003 | bedrag negatief |
| 4004 | ecb004 | bb_id onbekend bij CB |
| 4005 | ecb005 | po_id reeds bij CB |
| 4006 | ecb006 | ob_id ≠ verzendende bank |
| 4007 | ecb007 | duplicate po_id in batch |

### Onze eigen codes (4100+)
| Code | Betekenis |
|---|---|
| 4100 | validation failed |
| 4101 | onvoldoende saldo |
| 4102 | OA niet in deze bank |
| 4103 | BA niet in deze bank |
| 4104 | invalid BIC |
| 4105 | invalid IBAN |
| 4106 | invalid datetime |
| 4107 | invalid po_id |
| 4108 | amount > 2 decimalen |
| 4010 | auth missing |
| 4011 | auth invalid |
| 4040 | not found |
| 5000 | server error |
| 5020 | CB upstream error |

---

## Geverifieerde CB feiten
- Token endpoint: `/token` POST, geldig **4 uur**
- Token zit **direct in root**, niet in `data` wrapper
- Auth: `Authorization: Bearer <token>`
- `/po_out` en `/ack_out` zijn **DESTRUCTIEF** — gebruik `/test/true` voor debugging
- 2 extra error codes (4006, 4007) bovenop de manual

---

## Roadmap

- [x] Schema + seed (40 accounts)
- [x] Publieke endpoints
- [x] Middleware (auth, bank context)
- [x] PO_NEW generator + add
- [x] OB-flow afgewerkt
- [x] CB client geverifieerd
- [x] Token caching (4u)
- [x] Auto-refresh op 401
- [x] Safe peek endpoints
- [x] Error code namespacing
- [ ] BB-flow: `/po_in_fetch` + `/po_in_process` + ACK_OUT
- [ ] ACK_IN fetch + finaliseren TX
- [ ] Admin GUI
- [ ] Tests met andere teams

# x402 Invocation Telemetry Standard

Every x402-protected API server at Merit Systems must log invocations to a shared ClickHouse table with consistent identity and metadata fields. This spec defines the client header contract, the server-side implementation requirements, and the shared package that enforces both.

The goal: when someone looks at a row in `mcp_resource_invocations`, they can answer **who** called (wallet), **from what** (client), and **within which context** (session) — with confidence.

---

## Client Headers

Three custom headers carry identity. Clients MUST send the first two on every request. The third is strongly recommended.

| Header | Required | Format | Description |
|---|---|---|---|
| `X-Wallet-Address` | Yes | Lowercase `0x`-prefixed, 42-char hex | The caller's wallet address. Used for user identification and partner association. |
| `X-Client-ID` | Yes | Registered string from the Client Registry | Identifies **what software** is making the call. Must be a known value, not a wallet address or random ID. |
| `X-Session-ID` | Recommended | Opaque string, max 128 chars | Groups related invocations into a logical session. Meaning is client-defined (e.g., a chat ID, a workflow run). |

### Rules

- `X-Wallet-Address` MUST be lowercase. Servers normalize it anyway, but clients should send it correctly.
- `X-Client-ID` MUST be a value from the Client Registry below. Sending a wallet address, UUID, or arbitrary string defeats the purpose. If your client isn't registered, use `unknown` and register it.
- `X-Session-ID` is opaque to the server. Clients choose the granularity. Poncho uses chat IDs. The MCP server generates a random hex per process. Both are fine. What matters is that related calls share the same value.
- Standard HTTP headers (`Referer`, `User-Agent`) are logged for diagnostics but are NOT used for classification. Don't abuse them for identity.

---

## Client Registry

Canonical list of `X-Client-ID` values. Classification logic in the dashboard matches on these exactly.

| Client ID | Software | Set by |
|---|---|---|
| `poncho` | Poncho desktop app | Hardcoded via `--provider poncho` flag when spawning MCP |
| `x402scan-mcp` | @x402scan/mcp server (in any host: Claude Code, Cursor, etc.) | Default when no `--provider` flag is specified |
| `stablestudio-web` | StableStudio browser frontend | Set in the TRPC provider and x402 fetch hook |
| `x402scan-web` | x402scan.com web app | Set in frontend fetch calls |
| `unknown` | Unrecognized or raw API callers | Fallback — never explicitly sent, assigned by classification logic when `X-Client-ID` is null or unrecognized |

### Adding a new client

1. Choose a short, lowercase, hyphenated identifier (e.g., `partner-acme-bot`).
2. Add it to this table.
3. Have the client send it as `X-Client-ID` on every request.
4. The dashboard will classify it automatically — no server-side changes needed.

### MCP host attribution (future)

The MCP server receives `clientInfo.name` from the host IDE during the `initialize` handshake (e.g., `"claude-code"`, `"cursor"`). This is not currently forwarded. When we need IDE-level attribution, the MCP server should capture this and send it as `X-MCP-Host`. The ClickHouse schema has room for this column. Not required today.

---

## Server Implementation

### What every server must do

1. **Extract** the three headers from every incoming request.
2. **Log** a row to `mcp_resource_invocations` at every exit point — success, validation error, handler error, timeout. No request should go unlogged.
3. **Normalize** `X-Wallet-Address` to lowercase before storing.
4. **Store** the full request and response (headers + body) for forensic analysis.
5. **Fire-and-forget** — ClickHouse inserts must never block the response. The entire telemetry code path — from header extraction through ClickHouse insert — MUST be wrapped in a synchronous try/catch. Errors MUST be logged server-side only (e.g., `console.error`). No telemetry operation may throw an exception that propagates to the caller. No telemetry operation may reject a promise that is awaited by the caller.

### Scope boundary

The telemetry package is a **passive observer**. It reads headers, records data, and gets out of the way. It MUST NOT participate in:
- x402 payment verification, settlement, or response construction
- MPP response building or protocol negotiation
- Any response shaping or status code decisions

Payment handling, pricing, and protocol responses remain the server's responsibility. The package observes the outcome (status code, duration, headers) but never influences it.

### What the shared package handles

All of the above. Instead of copy-pasting the telemetry logic between servers, import `@merit-systems/x402-server-telemetry`. The package provides two APIs:

#### Simple wrapper

For existing route handlers or non-x402 routes that still need telemetry:

```typescript
import { withTelemetry } from '@merit-systems/x402-server-telemetry';

export const POST = withTelemetry(async (request, ctx) => {
  // ctx.walletAddress, ctx.clientId, ctx.sessionId are pre-extracted
  // Logging happens automatically on return or throw
  return NextResponse.json({ ok: true });
});
```

#### Route builder (convenience layer)

For x402-protected routes with Zod validation (the enrichx402 pattern), a higher-level builder composes telemetry with validation and x402 wrapping. This is a **convenience API built on top of the core telemetry**, not part of the telemetry contract itself. It is optional — servers can use `withTelemetry` directly and handle x402/validation themselves.

```typescript
import { createRouteBuilder } from '@merit-systems/x402-server-telemetry';

const route = createRouteBuilder();

export const POST = route
  .price('0.01', 'base:84532')
  .body(myInputSchema)
  .output(myOutputSchema)
  .description('Search for people by name or email')
  .handler(async ({ body, query, request }) => {
    const result = await searchPeople(body);
    return result;
  });
```

The builder composes:
- **Telemetry** (core): header extraction, normalization, ClickHouse logging at every exit point
- **Validation** (convenience): Zod body/query validation with user-friendly error messages
- **x402** (convenience): payment wrapping via `@x402/next` when `.price()` is used, Bazaar discovery extension generation from Zod schemas
- **Reliability** (convenience): timeout detection, `{ success: false }` detection to prevent x402 settlement on failures

The x402 and validation logic in the builder delegates to `@x402/next` and `zod` respectively — the telemetry package does not implement payment or protocol logic itself.

#### Package configuration

ClickHouse connection is configured once at app startup. Use the `TELEM_CLICKHOUSE_*` env var prefix to avoid collision with application-level ClickHouse config (e.g., mppScan uses ClickHouse as its primary database).

```typescript
// instrumentation.ts or similar
import { initTelemetry } from '@merit-systems/x402-server-telemetry';

await initTelemetry({
  clickhouse: {
    url: process.env.TELEM_CLICKHOUSE_URL,
    database: process.env.TELEM_CLICKHOUSE_DATABASE,
    username: process.env.TELEM_CLICKHOUSE_USERNAME,
    password: process.env.TELEM_CLICKHOUSE_PASSWORD,
  },
});
```

The `initTelemetry` function accepts explicit config, not env vars directly — the env var names above are the convention, not a requirement. If a service uses the same ClickHouse instance for both app data and telemetry, it can pass the same credentials under the `TELEM_*` prefix.

### Verified wallet address (cryptographic proof)

When a request includes an x402 payment, the `PAYMENT-SIGNATURE` header contains a signed payment payload with the payer's wallet at `payload.authorization.from` (EVM exact scheme). If the handler is executing, the `withX402` middleware has already cryptographically verified this signature — so the package can safely decode the header and extract the proven address within the handler itself.

For SIWE-authenticated routes (e.g., stablestudio job listing), the application verifies the `SIGN-IN-WITH-X` header and can pass the proven address to the telemetry context via `ctx.setVerifiedWallet()`.

The package stores the result in a `verified_wallet_address` column. This enables:
- **Confidence scoring**: when `X-Wallet-Address` matches `verified_wallet_address`, the identity is cryptographically proven.
- **Mismatch detection**: when they differ, something is wrong (misconfigured client, spoofing attempt).
- **Honest nulls**: for free/probe requests (no payment or SIWE), `verified_wallet_address` is null. That's expected.

This is not a client requirement — the verified address comes from decoding the payment or auth headers server-side. The package handles x402 payments automatically; SIWE requires a one-line call from the app.

---

## ClickHouse Schema

Reference table definition. All servers write to the same table. This DDL is for documentation — table creation and schema migration are operational concerns, not handled by the package. The package exports a typed `McpResourceInvocation` interface and a typed `insert<McpResourceInvocation>()` function. These are the actual contracts that servers depend on. Schema evolution is coordinated by `ALTER TABLE` migrations and corresponding updates to the package's type definition.

```sql
CREATE TABLE IF NOT EXISTS mcp_resource_invocations (
    -- Request identity
    id                      String,
    x_wallet_address        Nullable(String),    -- from X-Wallet-Address (lowercased)
    x_client_id             Nullable(String),    -- from X-Client-ID (registered string)
    session_id              Nullable(String),    -- from X-Session-ID
    verified_wallet_address Nullable(String),    -- from x402 payment settlement (new)

    -- Request metadata
    method                  String,
    route                   String,
    origin                  String,              -- server's own origin (not client-controllable)
    referer                 Nullable(String),    -- standard HTTP Referer
    request_content_type    Nullable(String),
    request_headers         Nullable(String),    -- full headers as JSON
    request_body            Nullable(String),    -- full body as JSON

    -- Response metadata
    status_code             UInt16,
    status_text             String,
    duration                UInt32,              -- milliseconds
    response_content_type   Nullable(String),
    response_headers        Nullable(String),    -- full headers as JSON
    response_body           Nullable(String),    -- full body as JSON

    -- Timestamps
    created_at              DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
ORDER BY (created_at, id)
PARTITION BY toYYYYMM(created_at)
```

### Column notes

- `origin` is the server's own URL (e.g., `https://enrichx402.com`). It is NOT from a client header. It reliably identifies which server processed the request.
- `x_wallet_address` uses the `x_` prefix for historical reasons. New columns should not use this prefix.
- `request_headers` and `request_body` store the full payload for debugging. Be aware of PII implications — these contain everything the client sent.
- `verified_wallet_address` is new. Add it with: `ALTER TABLE mcp_resource_invocations ADD COLUMN verified_wallet_address Nullable(String) AFTER session_id`.

---

## Client Type Classification

The dashboard (manual-hog) derives a `client_type` label from the logged data. The rules are applied in order — first match wins.

### Go-forward rules (after all clients conform to this spec)

```sql
CASE
  WHEN x_client_id = 'poncho'            THEN 'Poncho'
  WHEN x_client_id = 'x402scan-mcp'      THEN 'MCP'
  WHEN x_client_id = 'stablestudio-web'  THEN 'StableStudio'
  WHEN x_client_id = 'x402scan-web'      THEN 'x402scan Web'
  -- Add new clients here as they register
  ELSE                                        'Unknown'
END
```

This is deterministic. No heuristics. If a value is in the registry, it gets a label. If not, it's Unknown.

### Historical rules (for data before clients were updated)

```sql
CASE
  WHEN x_client_id = 'poncho'                       THEN 'Poncho'
  WHEN origin LIKE '%stablestudio%'                  THEN 'StableStudio'
  WHEN match(x_client_id, '^0x[0-9a-fA-F]{40}$')    THEN 'MCP'
  WHEN referer LIKE 'x402scan-mcp%'                  THEN 'MCP'
  ELSE                                                    'Unknown'
END
```

The `0x`-wallet-address heuristic has high confidence because only MCP clients set `X-Client-ID` to a wallet address. No other known client does this. Once the upstream changes land, new data will use the go-forward rules and the historical rules become irrelevant for classification accuracy.

### User-level classification

A wallet address may appear with multiple client types across invocations (e.g., someone uses both Poncho and MCP). The user-level label should be:
- The **most recent** client type (what they're using now), or
- **Multi-client** if they've used 2+ client types in the last 30 days

---

## Migration

### Upstream changes required

| Repo | Change | Lines |
|---|---|---|
| `x402scan` (monorepo MCP) | Change default provider in `x402-fetch.ts:73` from `account.address` to `'x402scan-mcp'` | 1 |
| `x402scan` (monorepo MCP) | Pass `provider` to `buildRequest()` in `auth-fetch.ts:48` and `check-endpoint.ts:47` (fixes bug where `X-Client-ID` is sent as the string `"undefined"`) | 2 |
| `x402scan-mcp` (standalone) | Change `X-Client-ID` in `keystore.ts:103` from `cachedWalletAddress` to `'x402scan-mcp'` | 1 |
| `stablestudio` | Change `getClientId()` in `constants.ts` for x402 API calls to return `'stablestudio-web'` instead of a localStorage UUID. (Keep the UUID for TRPC/internal use if needed.) | Small |
| `x402-tools` (enrichx402) | Extract telemetry into `@merit-systems/x402-server-telemetry` package. Add `verified_wallet_address` column and in-handler extraction from `PAYMENT-SIGNATURE`. | Medium |
| `manual-hog` | Add `client_type` derivation to queries, add column + filter to UI | Medium |

### Historical data

Run once after adding the `verified_wallet_address` column:

```sql
ALTER TABLE mcp_resource_invocations
  ADD COLUMN IF NOT EXISTS verified_wallet_address Nullable(String) AFTER session_id;
```

No backfill is needed for `verified_wallet_address` — it only applies to future paid requests. The classification rules handle historical data through the fallback heuristics described above.

---

## Open Questions

1. **Should `X-Client-ID` be renamed to `X-Client-Type`?** The current name implies a unique identifier, but the spec defines it as a categorical label. Renaming is cleaner semantically but requires updating all clients. Current recommendation: keep the name, redefine the semantics. The spec is the source of truth, not the header name.

2. **Should we capture `X-MCP-Host` now or later?** It would tell us which IDE hosts the MCP (Claude Code vs Cursor). The MCP server already receives this info during `initialize`. Adding it now is cheap but adds a column that's mostly null until the MCP server forwards it. Current recommendation: add the column now, implement forwarding when we need the data.

3. **Should the ClickHouse table be renamed from `mcp_resource_invocations`?** The name is MCP-specific but the data includes non-MCP calls (stablestudio web, raw API). Renaming is a breaking change across manual-hog. Current recommendation: keep the name. It works. A comment in the schema is enough.

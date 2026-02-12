# Telemetry Implementation Plan

Follow-up work for the telemetry spec at `docs/telemetry-spec.md`. Covers the shared package, dashboard features, upstream client changes, and open concerns.

---

## 1. Shared Package: `@merit-systems/x402-server-telemetry`

Build before implementing any more servers. The next server is the test case — if it takes more than 10 lines to add telemetry, the package isn't thin enough.

### What it provides

Three APIs for different levels of control:

**Route builder** (full control: validation, x402, telemetry):
```typescript
import { createRoute } from '@merit-systems/x402-server-telemetry';
const route = createRoute();

export const POST = route
  .price('0.05', 'base:8453')
  .body(searchSchema)
  .handler(async ({ body }) => searchPeople(body));
```

**Simple wrapper** (just telemetry around an existing handler):
```typescript
import { withTelemetry } from '@merit-systems/x402-server-telemetry';

export const POST = withTelemetry(async (request, ctx) => {
  // ctx.walletAddress, ctx.clientId, ctx.sessionId pre-extracted
  return NextResponse.json(result);
});
```

**SIWX wrapper** (telemetry + SIWX verification in one shot):
```typescript
import { withSiwxTelemetry } from '@merit-systems/x402-server-telemetry';

export const GET = withSiwxTelemetry(async (request, ctx) => {
  // ctx.verifiedWallet already set from SIWX header verification
  return NextResponse.json(await getJobs(ctx.verifiedWallet));
});
```

`withSiwxTelemetry` delegates SIWX verification to `@x402/core`'s `parseSIWxHeader` / `verifySIWxSignature` — the telemetry package does not implement SIWX itself. It composes verification with telemetry so that SIWX routes are one-liners instead of 3-5 lines of verify → extract → setVerifiedWallet boilerplate. The `ctx.setVerifiedWallet()` escape hatch remains available on `withTelemetry` for non-SIWX auth (e.g., API key routes where the wallet comes from a DB lookup).

### What it handles automatically (core telemetry)

- Header extraction + normalization (lowercase wallet, etc.)
- ClickHouse singleton client and connection management (no auto table creation — that's an ops concern)
- Logging at every exit point (400, 500, 504, 200) — currently 5 copy-pasted blocks in enrichx402's route-builder
- Verified wallet extraction from x402 payment headers (see Cryptographic Proof section below)
- Fire-and-forget ClickHouse insert wrapped in synchronous try/catch — zero exceptions escape to the caller, zero promises awaited by the caller. A ClickHouse outage must never take down a production route.
- Exports typed `McpResourceInvocation` interface and `insert<McpResourceInvocation>()` — the TypeScript types are the real contract, not the DDL

### What the route builder adds (convenience layer on top of core)

The route builder is optional. It composes telemetry with validation and x402 wrapping for the enrichx402 pattern:
- Zod body/query validation with user-friendly error messages
- x402 payment wrapping via `@x402/next` when `.price()` is used
- Bazaar discovery extension generation from Zod schemas
- Timeout detection and `{ success: false }` settlement prevention

The route builder delegates to `@x402/next` and `zod` — the telemetry package itself does NOT implement payment verification, settlement, response construction, or MPP protocol logic. It is a passive observer.

### What it does NOT handle

- Business logic
- x402 payment verification, settlement, or response construction (the package observes outcomes, never influences them)
- MPP response building or protocol negotiation
- Application-specific authentication (Privy, SIWE, etc.) — but exposes `ctx.setVerifiedWallet()` for apps that do their own auth
- x402 pricing decisions (that's per-route config)
- Table creation or schema migration (ops concern, handled by ALTER TABLE)

### Compatibility requirements

The package must work with both x402 integration patterns found across our services:

**`withX402` wrapper** (enrichx402, x402email, x402-live-portrait, agentfacilitator):
```typescript
// Package wraps inner handler, withX402 wraps the result
export const POST = withX402(
  route.handler(async ({ body }) => process(body)),
  routeConfig, server
);
```

**Manual x402 verification** (agentupload, stablestudio):
```typescript
// Package wraps the whole handler, app does its own x402 flow inside
export const POST = withTelemetry(async (request, ctx) => {
  const payment = decodePaymentSignatureHeader(...);
  await x402Server.verifyPayment(payment, req);
  await x402Server.settlePayment(payment, req);
  // ... business logic ...
  return result;
});
```

Both patterns work for verified wallet extraction — the `PAYMENT-SIGNATURE` header is present in the request regardless of which pattern handles the verification.

Additionally, check for the `x-payer-address` header that `@x402/next`'s `withX402` may inject after verification. If present, prefer it over manual header decoding since the middleware has already done the work.

### Source

Extract from `x402-tools/lib/x402/route-builder.ts` (~700 lines) and `x402-tools/lib/clickhouse/clickhouse.ts` (~89 lines). Also subsumes `x402email/src/lib/x402/route-wrapper.ts` (`createX402PostRoute`) and `x402email/src/lib/x402/extract-wallet.ts` (`extractPayerWallet`), which are copies of the same pattern. About 400 lines are reusable telemetry/validation plumbing. The rest is x402-specific config that stays in enrichx402 or moves into the builder's `.price()` path.

### Where to publish

Public npm package under the `@merit-systems` org:

```json
"@merit-systems/x402-server-telemetry": "^1.0.0"
```

Source lives at `Merit-Systems/x402-telemetry` on GitHub. Published to npm's public registry — zero auth config needed for consumers. No `.npmrc`, no PATs, no registry overrides. Works out of the box on Vercel, Railway, GitHub Actions, and local dev.

The package is infrastructure plumbing (header extraction, ClickHouse logging) with no secrets or business logic, so public exposure is fine.

Publish workflow: GitHub Action on tag push (`v*`) runs `npm publish --access public`. Team members with npm org access can also publish manually.

### Build and publish setup

Only ship compiled output to npm — no source, tests, or config files. The `files` field in `package.json` whitelists exactly what gets published:

```json
{
  "name": "@merit-systems/x402-server-telemetry",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup src/index.ts --format esm,cjs --dts",
    "prepublishOnly": "npm run build"
  }
}
```

`files: ["dist"]` means npm only packs `dist/`, `package.json`, `README.md`, and `LICENSE`. Everything else (src/, tests/, tsconfig, .github/, etc.) stays in the repo but never hits the registry. `prepublishOnly` ensures a fresh build before every publish.

Use `npm pack --dry-run` to verify what ships before publishing.

Dependencies: `@x402/core`, `@x402/next`, `@x402/extensions`, `@clickhouse/client`, `zod`. Each consuming server provides its own ClickHouse credentials via `TELEM_CLICKHOUSE_*` env vars at init time (namespaced to avoid collision with app-level ClickHouse config, e.g., mppScan).

---

## 2. Upstream Client Changes

~5 lines total across repos. Do these before or alongside the package work.

### x402scan (monorepo MCP)

**File:** `packages/external/mcp/src/server/tools/x402-fetch.ts:73`
```typescript
// Change:
const provider = flags.provider ?? account.address;
// To:
const provider = flags.provider ?? 'x402scan-mcp';
```

**Files:** `packages/external/mcp/src/server/tools/auth-fetch.ts:48` and `check-endpoint.ts:47`

Both call `buildRequest({ input, address, sessionId })` without passing `provider`, which sends `X-Client-ID: "undefined"` (the string). Fix by passing `provider` through:
```typescript
buildRequest({ input, address: account.address, sessionId, provider })
```

Where `provider` is resolved the same way as in x402-fetch (`flags.provider ?? 'x402scan-mcp'`). This likely means threading `flags` through to these tool registrations or resolving `provider` once at server init and passing it as part of the shared tool props.

### x402scan-mcp (standalone)

**File:** `src/keystore.ts:103`
```typescript
// Change:
'X-Client-ID': cachedWalletAddress,
// To:
'X-Client-ID': 'x402scan-mcp',
```

### stablestudio

For x402 API calls from the web frontend, set `X-Client-ID` to `'stablestudio-web'` instead of the localStorage UUID. The localStorage UUID can remain for internal TRPC use if needed.

**File:** `src/hooks/use-x402.ts` — in `addTelemetryHeaders()`, change the `CLIENT_ID` value.

**File:** `src/app/api/x402/[model]/[operation]/route.ts` — for server-side x402 route logging, if the client doesn't send `X-Client-ID`, the server could default to `'stablestudio-web'` since it knows its own origin.

---

## 3. Dashboard Features (manual-hog)

### Client type column on users list

Add a derived `client_type` to the users API query. Use the classification CASE expression from the spec. Show as a plain text column in the users table — no badges, no color. The label should be trustworthy enough to not need visual emphasis.

Add a filter dropdown for client type so you can view just Poncho users, just MCP users, etc.

### Per-session client context

On the sessions page and user detail page, show which client was used for each session. A user might use Poncho for most sessions but occasionally use raw MCP — that's visible at the session level.

### User detail: attribution chain

On the user detail page, show how the user arrived:
- Invite code (if redeemable, which partner gave it)
- First seen date
- First client type (what they used on day 1)
- Current client type (what they use now)
- Wallet funded by (from `erc20_transfers.sender`, joinable to partners)

### Tool usage per user

Aggregate the `route` column into a tool usage breakdown on user detail:
- Most-used tools (sorted list or small bar chart)
- Error rate per tool
- Tool discovery over time (when did they first try each tool?)

### Engagement segmentation

Classify users into tiers based on recency/frequency. Show as a filter on the users list and a summary on the home dashboard:
- **Power user** — multiple sessions/week, diverse tool usage
- **Regular** — weekly activity
- **Occasional** — monthly
- **Churned** — no activity in 2+ weeks
- **New** — first seen in last 7 days

### Partner rollup

On partner detail, show aggregate stats across their users:
- Total users, active (last 7d), new (last 7d)
- Client type breakdown
- Top tools used
- Total revenue / USDC spent

---

## 4. Cryptographic Wallet Verification

### The problem

`X-Wallet-Address` is self-reported. Any client can claim any wallet. For paid requests, the x402 payment cryptographically proves the real payer — but today that proof is only console.logged in `onAfterSettle` (`x402-tools/lib/x402/server.ts:49`), never stored in ClickHouse.

### Three proof mechanisms already exist

**x402 payment signature** — The `PAYMENT-SIGNATURE` header (v2) or `X-PAYMENT` header (v1) contains a signed payment payload. The payer's wallet is at `payload.authorization.from` (EVM exact scheme) or `payload.from` (fallback). When the `withX402` middleware lets the handler run, it has already verified this signature. `decodePaymentSignatureHeader` is available from `@x402/core/http`, already a dependency of both enrichx402 and stablestudio.

**x402 settlement** — After the handler returns, `onAfterSettle` fires with `ctx.result.payer` (the on-chain payer). This is the strongest proof but arrives too late — the ClickHouse log is already written by the time it fires.

**SIWE (Sign-In-With-Ethereum)** — The `SIGN-IN-WITH-X` header contains a signed CAIP-122 message. Stablestudio already verifies this via `verifySIWxSignature()` for read-only routes (job listing, job status). The verified address comes from `verification.address`.

### The key insight

If the handler is executing, the `withX402` middleware has already verified the payment. So the handler (or the telemetry package wrapping it) can safely decode the `PAYMENT-SIGNATURE` header and extract the payer — the middleware guarantees the signature is valid.

This means extraction happens during the normal request lifecycle, not in a late-firing callback. No second ClickHouse write, no async update.

### What the package does automatically (x402 payments)

Inside the telemetry wrapper, before logging to ClickHouse. Checks multiple header sources in priority order:

```typescript
function extractVerifiedWallet(request: NextRequest): string | null {
  // 1. x-payer-address: injected by @x402/next's withX402 after verification.
  //    Highest confidence — the middleware already did the work.
  const payerAddress = request.headers.get('x-payer-address');
  if (payerAddress) {
    return payerAddress.toLowerCase();
  }

  // 2. PAYMENT-SIGNATURE / X-PAYMENT: decode the payment header directly.
  //    If the handler is executing, withX402 has already verified this.
  //    For manual x402 flows (agentupload), the app verifies before calling business logic.
  const paymentHeader =
    request.headers.get('PAYMENT-SIGNATURE') ??
    request.headers.get('payment-signature') ??
    request.headers.get('X-PAYMENT') ??
    request.headers.get('x-payment');

  if (!paymentHeader) return null;

  try {
    const payment = decodePaymentSignatureHeader(paymentHeader);
    const from =
      payment?.payload?.authorization?.from ??  // EVM exact scheme
      payment?.payload?.from;                   // fallback
    return typeof from === 'string' ? from.toLowerCase() : null;
  } catch {
    return null;
  }
}
```

This runs for every request. For paid requests, it extracts the cryptographically verified payer — zero app code needed. For free/probe requests (no payment header), it returns null. The `x-payer-address` check means any server using `withX402` gets verified wallet extraction without even decoding the payment header.

### What the app does explicitly (SIWE auth)

For SIWX routes, the preferred approach is the `withSiwxTelemetry` wrapper which handles verification and wallet extraction in one shot:

```typescript
import { withSiwxTelemetry } from '@merit-systems/x402-server-telemetry';

// One-liner — verification + telemetry + verified wallet all handled
export const GET = withSiwxTelemetry(async (request, ctx) => {
  return await getJobs(ctx.verifiedWallet);
});
```

For non-SIWX auth (API-key routes, Privy, etc.), the handler context exposes a manual setter:

```typescript
// agentfacilitator API-key route — wallet comes from DB lookup
export const POST = withTelemetry(async (request, ctx) => {
  const { wallet } = await validateApiKey(request);
  ctx.setVerifiedWallet(wallet);
  return await processRequest(wallet);
});
```

Three paths, same `verified_wallet_address` column:
- **x402 payments**: package extracts automatically from `x-payer-address` or `PAYMENT-SIGNATURE` (zero app code)
- **SIWX auth**: `withSiwxTelemetry` wrapper handles verification + extraction (one-liner)
- **Other auth**: app calls `ctx.setVerifiedWallet()` after its own verification (manual, for API-key/Privy/etc.)

### What this gives the dashboard

Every invocation has two wallet fields:

| Column | Source | Trust level |
|---|---|---|
| `x_wallet_address` | `X-Wallet-Address` header | Self-reported |
| `verified_wallet_address` | x402 payment or SIWE | Cryptographic proof |

Display logic:
- **Both present and match** → Verified identity (paid request, wallet confirmed)
- **Only `x_wallet_address`** → Unverified (free probes, discovery calls — expected and honest)
- **Both present but different** → Mismatch (misconfigured client or spoofing — flag it)

At the user level: what percentage of their requests are verified? Power users making paid calls will be near 100%. Users who only probe endpoints will be 0%. Both are fine — the point is knowing the difference.

### What can't be cryptographically proven

**Client type (`X-Client-ID`) has no proof mechanism.** The x402 payment proves *who* (wallet), not *what software*. You can't cryptographically prove a request came from Poncho vs Claude Code — only that it came from a specific wallet.

This is fine. Client type is an analytics dimension, not a security boundary. If someone spoofs `X-Client-ID: poncho`, you still know their verified wallet. The worst case is a slightly wrong pie chart.

If client type ever becomes a security boundary (rate limits, feature gates), the approach would be server-issued tokens — but that's API key infrastructure, not telemetry.

### ClickHouse schema change

```sql
ALTER TABLE mcp_resource_invocations
  ADD COLUMN IF NOT EXISTS verified_wallet_address Nullable(String) AFTER session_id;
```

No backfill needed. Historical rows have `NULL` — they predate the feature. Going forward, paid requests get a verified address automatically.

---

## 5. Concerns and Weak Spots

### Self-reported client ID is unverified

`X-Client-ID` is a header anyone can set. A raw caller could send `X-Client-ID: poncho` and get misclassified. For internal analytics this is fine — we control the clients. But if we ever gate behavior on client type (rate limits, pricing tiers, feature flags), self-reported headers aren't sufficient. We'd need signed identity, which x402 gives us for the wallet but not for the client.

**Mitigation:** The `verified_wallet_address` from x402 settlement proves *who* is calling. The client type is less security-sensitive — it's more of an analytics dimension than an access control mechanism.

### The "Unknown" bucket is a black hole

New partners building custom integrations who don't read the spec will land in "Unknown" with no way to distinguish them from raw curl calls.

**Mitigation:** The server-side package should log a `unregistered_client` flag when `X-Client-ID` is null or doesn't match the registry. The dashboard can surface a "new unregistered clients" alert so you notice new integrations immediately instead of them silently accumulating.

### MCP host attribution is a blind spot

The MCP server runs inside Claude Code, Cursor, Windsurf, etc. These all look identical in the data today. The MCP `initialize` handshake includes `clientInfo: { name, version }` from the host IDE — the server receives this but doesn't forward it.

**Future work:** Capture `clientInfo.name` during MCP init, store it, send as `X-MCP-Host` header. Add `mcp_host Nullable(String)` column to ClickHouse. Low effort, high value for understanding which IDE environments drive usage. Not blocking for the core spec.

### Full request/response logging has PII implications

`request_headers` and `request_body` store everything the client sent, including potentially sensitive data. `response_body` may include PII from upstream providers (people search results, etc.).

**Consider:** retention policies, column-level access controls, or redaction rules for sensitive fields. Not urgent but worth thinking about before the data volume grows.

### ClickHouse table name is MCP-specific

`mcp_resource_invocations` implies MCP, but the table holds all invocations including web frontend and raw API calls. Renaming is a breaking change across all manual-hog queries. Not worth doing now, but worth noting that the name is misleading.

---

## 6. Server Onboarding

Four services currently have zero ClickHouse telemetry. They're invisible in the dashboard. Adding the package to each one makes them visible.

### Current state per service

| Service | What it does | x402 Pattern | Existing telemetry | Effort to onboard |
|---|---|---|---|---|
| **x402email** | Pay-per-send email (SES) | `withX402` + custom `createX402PostRoute` | Prisma SendLog + console | Low — replace `createX402PostRoute` with package's route builder. Delete `route-wrapper.ts` and `extract-wallet.ts`. |
| **agentfacilitator** | Pay-as-you-go x402 facilitator proxy | `withX402` (inbound) + x402 client (outbound) | Prisma Transaction + console | Low — wrap route handlers with `withTelemetry`. Note: also makes outbound x402 payments (email, transfers) — decide if we log those too. |
| **agentupload** | Pay-per-upload file hosting (S3) | Manual x402 verification | Prisma Upload + console | Medium — manual x402 flow means using `withTelemetry` wrapper, not the route builder. App keeps its own verification logic. |
| **x402-live-portrait** | Pay-per-generation portrait animation (Modal GPU) | `withX402` wrapper | Console only | Low — wrap handlers with `withTelemetry` or route builder. Long-running requests (5 min) are fine — duration is UInt32 ms. |

### Per-service changes

**x402email:**
- Add `@merit-systems/x402-server-telemetry` dependency
- Add `TELEM_CLICKHOUSE_*` env vars to Vercel
- Replace `createX402PostRoute()` calls with `route.price().body().handler()` — API shape should be close to drop-in (see API compatibility note below)
- Replace `extractPayerWallet()` calls — package auto-extracts from `x-payer-address` / `PAYMENT-SIGNATURE`
- Delete `src/lib/x402/route-wrapper.ts` and `src/lib/x402/extract-wallet.ts`
- SIWX-only routes: one-liner with `withSiwxTelemetry`

**agentfacilitator:**
- Add `@merit-systems/x402-server-telemetry` dependency
- Add `TELEM_CLICKHOUSE_*` env vars to Vercel
- x402-protected routes (`/api/deposit`): route builder — verified wallet auto-extracted
- SIWX routes (`/api/balance`, `/api/signers`, etc.): one-liner with `withSiwxTelemetry`
- API-key-auth routes (`/api/facilitator/v2/[id]/*`): `withTelemetry` + `ctx.setVerifiedWallet()` after DB lookup (only routes that still need manual wallet setting)
- Decision needed: log outbound x402 payments to x402email.com and x402scan.com? This would show the facilitator's own spending in the dashboard.

**agentupload:**
- Add `@merit-systems/x402-server-telemetry` dependency
- Add `TELEM_CLICKHOUSE_*` env vars to Vercel
- Upload route: `withTelemetry` wrapper — app keeps manual x402 flow inside, but package auto-extracts `verified_wallet_address` from `PAYMENT-SIGNATURE` header
- SIWX read routes: one-liner with `withSiwxTelemetry`

**x402-live-portrait:**
- Add `@merit-systems/x402-server-telemetry` dependency
- Add `TELEM_CLICKHOUSE_*` env vars to Vercel
- Wrap `/api/generate-x402` with route builder (replace inline `withX402` call) — verified wallet auto-extracted from `x-payer-address`
- Wrap `/api/uploads` with route builder
- `maxDuration = 300` (5 min) is fine — ClickHouse UInt32 handles up to ~50 days in ms

### API compatibility with x402email's `createX402PostRoute`

When building the route builder, match the API shape of x402email's `createX402PostRoute()` as closely as possible. x402email has 19 endpoints using it — if the package's route builder is a near-drop-in replacement, migration is a find-and-replace on the import path. Examine the exact function signature and options of `createX402PostRoute` during package development and ensure compatibility (or export a thin adapter if the APIs diverge).

### What this unlocks in the dashboard

Once all six services log to ClickHouse, manual-hog shows the full picture:
- Every x402 API call across the entire platform
- Per-user tool usage spanning enrichx402, stablestudio, email, upload, animation, facilitator
- Revenue attribution across all services (which tools generate the most USDC)
- Error rates and patterns across the fleet
- Client type breakdown per service (which services are MCP-heavy vs web-heavy)

---

## 7. Implementation Order

1. **Upstream client changes** (~5 lines) — unblocks accurate classification immediately
2. **manual-hog: client_type column + filter** — delivers visible value from step 1
3. **Extract `@merit-systems/x402-server-telemetry` package** — prevents future drift, unblocks everything below
4. **Onboard enrichx402 + stablestudio** to the package — replace copy-pasted telemetry code, add `verified_wallet_address` extraction
5. **Onboard x402email** — replace its copy-pasted route builder, biggest bang for the buck since it has the most routes (19 endpoints)
6. **Onboard agentupload, x402-live-portrait, agentfacilitator** — these are simpler (fewer routes, `withTelemetry` wrapper is enough)
7. **manual-hog: verification status in UI** — show verified/unverified/mismatch per invocation and user
8. **manual-hog: user detail enrichment** (attribution, tool usage, engagement) — deeper user understanding
9. **MCP host attribution** (`X-MCP-Host`) — when IDE-level data matters

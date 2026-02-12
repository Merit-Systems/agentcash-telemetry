# @merit-systems/x402-server-telemetry

Telemetry package for x402-protected API servers. Extracts identity headers, logs invocations to ClickHouse, and extracts verified wallet addresses from x402 payments and SIWX auth.

## Install

```bash
npm install @merit-systems/x402-server-telemetry
```

Peer dependencies — install what you need:

```bash
# Required
npm install @clickhouse/client

# Optional — for route builder (x402 + Zod validation)
npm install @x402/core @x402/next @x402/extensions zod
```

## Setup

Call `initTelemetry` once at app startup:

```typescript
import { initTelemetry } from '@merit-systems/x402-server-telemetry';

initTelemetry({
  clickhouse: {
    url: process.env.TELEM_CLICKHOUSE_URL!,
    database: process.env.TELEM_CLICKHOUSE_DATABASE,
    username: process.env.TELEM_CLICKHOUSE_USERNAME,
    password: process.env.TELEM_CLICKHOUSE_PASSWORD,
  },
  origin: 'https://your-server.com', // optional, auto-detected from request if not set
});
```

Use `TELEM_CLICKHOUSE_*` env vars to avoid collision with app-level ClickHouse config.

## Usage

### `withTelemetry` — core wrapper

Wrap any Next.js route handler. Extracts identity headers, logs the invocation to ClickHouse, and auto-extracts verified wallet from x402 payment headers.

```typescript
import { withTelemetry } from '@merit-systems/x402-server-telemetry';

export const POST = withTelemetry(async (request, ctx) => {
  // ctx.walletAddress  — from X-Wallet-Address header (lowercased)
  // ctx.clientId       — from X-Client-ID header
  // ctx.sessionId      — from X-Session-ID header
  // ctx.verifiedWallet — auto-extracted from x402 payment (or null)

  const result = await doWork(request);
  return NextResponse.json(result);
});
```

For non-x402 auth (API keys, Privy, etc.), set the verified wallet manually:

```typescript
export const POST = withTelemetry(async (request, ctx) => {
  const { wallet } = await validateApiKey(request);
  ctx.setVerifiedWallet(wallet);
  return NextResponse.json(await process(wallet));
});
```

### `withSiwxTelemetry` — SIWX + telemetry in one shot

For routes that require SIWX (Sign-In-With-X) wallet authentication. Verifies the `SIGN-IN-WITH-X` header, sets the verified wallet, and returns a 402 challenge if the header is missing.

```typescript
import { withSiwxTelemetry } from '@merit-systems/x402-server-telemetry';

export const GET = withSiwxTelemetry(async (request, ctx) => {
  // ctx.verifiedWallet is guaranteed to be set
  return NextResponse.json(await getJobs(ctx.verifiedWallet));
});
```

### `createRouteBuilder` — validation + x402 + telemetry

Convenience layer for x402-protected routes with Zod validation. Optional — you can always use `withTelemetry` directly.

```typescript
import { createRouteBuilder } from '@merit-systems/x402-server-telemetry';
import { x402Server } from './x402-server'; // your app's x402 server setup
import { z } from 'zod';

const route = createRouteBuilder({ x402Server });

const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional().default(10),
});

export const POST = route
  .price('0.05', 'base:8453')
  .body(searchSchema)
  .description('Search for people')
  .handler(async ({ body }) => {
    return await searchPeople(body.query, body.limit);
  });
```

For routes without x402 pricing, `x402Server` is not required:

```typescript
const route = createRouteBuilder();

export const POST = route
  .body(inputSchema)
  .handler(async ({ body }) => process(body));
```

## What gets logged

Every invocation writes a row to the `mcp_resource_invocations` ClickHouse table:

| Field | Source |
|---|---|
| `x_wallet_address` | `X-Wallet-Address` header (self-reported, lowercased) |
| `x_client_id` | `X-Client-ID` header (registered client type) |
| `session_id` | `X-Session-ID` header (client-defined session grouping) |
| `verified_wallet_address` | x402 payment or SIWX auth (cryptographic proof) |
| `method`, `route`, `origin` | Request metadata |
| `status_code`, `duration` | Response metadata |
| `request_headers`, `request_body` | Full request (for forensics) |
| `response_headers`, `response_body` | Full response (for forensics) |

## Verified wallet extraction

The package auto-extracts the verified wallet from x402 payments — zero app code needed:

1. Checks `x-payer-address` header (injected by `@x402/next`'s `withX402` after verification)
2. Falls back to decoding `PAYMENT-SIGNATURE` / `X-PAYMENT` header

For SIWX auth, use `withSiwxTelemetry` (automatic) or `ctx.setVerifiedWallet()` (manual).

## Error isolation

All telemetry code is wrapped in try/catch. A ClickHouse outage will never take down your API route. Telemetry errors are logged to `console.error` and silently swallowed.

## API

### `initTelemetry(config: TelemetryConfig): void`

Initialize the ClickHouse client. Call once at startup.

### `withTelemetry(handler): NextRouteHandler`

Wrap a route handler with telemetry logging.

### `withSiwxTelemetry(handler): NextRouteHandler`

Wrap a route handler with SIWX verification + telemetry.

### `createRouteBuilder(options?): RouteBuilder`

Create a chainable route builder with `.price()`, `.body()`, `.query()`, `.output()`, `.description()`, `.handler()`.

### `extractVerifiedWallet(headers: Headers): string | null`

Standalone utility to extract verified wallet from request headers.

### `HttpError`

Error class with a `status` code for proper error propagation in route builder handlers.

```typescript
import { HttpError } from '@merit-systems/x402-server-telemetry';

throw new HttpError('Resource not found', 404);
```

## Types

```typescript
import type {
  McpResourceInvocation,  // ClickHouse row shape
  TelemetryContext,       // Handler context (walletAddress, clientId, etc.)
  TelemetryConfig,        // initTelemetry config
  SiwxTelemetryContext,   // SIWX handler context (verifiedWallet guaranteed)
  RouteBuilderOptions,    // createRouteBuilder options
} from '@merit-systems/x402-server-telemetry';
```

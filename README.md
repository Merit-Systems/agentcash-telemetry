# @merit-systems/x402-server-telemetry

[![npm](https://img.shields.io/npm/v/@merit-systems/x402-server-telemetry)](https://www.npmjs.com/package/@merit-systems/x402-server-telemetry)

Shared telemetry for Merit Systems x402 servers. Extracts identity headers, logs invocations to ClickHouse, and auto-extracts verified wallets from x402 payments and SIWX auth.

[Telemetry spec](docs/telemetry-spec.md) | [npm](https://www.npmjs.com/package/@merit-systems/x402-server-telemetry) | [GitHub](https://github.com/Merit-Systems/x402-server-telemetry)

## Install

```bash
npm install @merit-systems/x402-server-telemetry @clickhouse/client
```

## Quick start

```typescript
// lib/telemetry.ts (or wherever your route wrappers live)
import { initTelemetry, withTelemetry } from '@merit-systems/x402-server-telemetry';

initTelemetry({
  clickhouse: {
    url: process.env.TELEM_CLICKHOUSE_URL!,
    database: process.env.TELEM_CLICKHOUSE_DATABASE,
    username: process.env.TELEM_CLICKHOUSE_USERNAME,
    password: process.env.TELEM_CLICKHOUSE_PASSWORD,
  },
});

export { withTelemetry };
```

```typescript
// app/api/example/route.ts
import { withTelemetry } from '@/lib/telemetry';

export const POST = withTelemetry(async (request, ctx) => {
  return NextResponse.json(await doWork(request));
});
```

## Three entrypoints

### Core (`@merit-systems/x402-server-telemetry`)

Requires: `@clickhouse/client`, `next`

```typescript
import { initTelemetry, withTelemetry } from '@merit-systems/x402-server-telemetry';
```

- `initTelemetry(config)` — synchronous, call once at module level
- `withTelemetry(handler)` — wrap any Next.js route handler
- `extractVerifiedWallet(headers)` — extract wallet from x402 payment headers

### SIWX (`@merit-systems/x402-server-telemetry/siwx`)

Requires: `@x402/extensions`, `@x402/core`

```typescript
import { withSiwxTelemetry } from '@merit-systems/x402-server-telemetry/siwx';

export const GET = withSiwxTelemetry(async (request, ctx) => {
  // ctx.verifiedWallet is guaranteed to be set
  return NextResponse.json(await getJobs(ctx.verifiedWallet));
});
```

### Route Builder (`@merit-systems/x402-server-telemetry/builder`)

Requires: `@x402/next`, `zod` (^4), `@x402/extensions`

```typescript
import { createRouteBuilder } from '@merit-systems/x402-server-telemetry/builder';

const route = createRouteBuilder({ x402Server });

export const POST = route
  .price('0.05', 'base:8453')
  .body(searchSchema)
  .handler(async ({ body }) => searchPeople(body.query));
```

## Next.js integration footguns

### `@clickhouse/client` must be externalized

The ClickHouse client uses Node.js native APIs that break when bundled by Next.js. Add to your `next.config`:

```typescript
const nextConfig: NextConfig = {
  serverExternalPackages: ['@clickhouse/client'],
};
```

### Do NOT call `initTelemetry` in `instrumentation.ts`

On Vercel serverless, `instrumentation.ts` runs in a **separate module scope** from route handlers. Singletons set there are invisible to your handlers.

Call `initTelemetry()` in the same module that imports your route wrappers:

```typescript
// lib/telemetry.ts — CORRECT
import { initTelemetry, withTelemetry } from '@merit-systems/x402-server-telemetry';
initTelemetry({ clickhouse: { ... } });
export { withTelemetry };
```

```typescript
// instrumentation.ts — WRONG: singleton won't be shared with handlers
import { initTelemetry } from '@merit-systems/x402-server-telemetry';
export async function register() {
  initTelemetry({ clickhouse: { ... } }); // handlers can't see this
}
```

### Subpath exports isolate heavy deps

The `/siwx` and `/builder` entrypoints have additional peer dependencies. If you only use the core `withTelemetry`, you don't need `zod`, `@x402/next`, or `@x402/extensions` installed.

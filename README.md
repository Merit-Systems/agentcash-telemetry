# @agentcash/telemetry

[![npm](https://img.shields.io/npm/v/@agentcash/telemetry)](https://www.npmjs.com/package/@agentcash/telemetry)

ClickHouse telemetry for x402/MPP/SIWX API services. Logs invocations to ClickHouse, extracts verified wallets from x402 payments and SIWX auth.

[Telemetry spec](docs/telemetry-spec.md) | [npm](https://www.npmjs.com/package/@agentcash/telemetry) | [GitHub](https://github.com/Merit-Systems/agentcash-telemetry)

## Install

```bash
pnpm add @agentcash/telemetry @clickhouse/client
```

## Quick start — Router Plugin (recommended)

```typescript
import { createRouter } from '@agentcash/router';
import { createTelemetryPlugin } from '@agentcash/telemetry/plugin';

const router = createRouter({
  payeeAddress: '0x...',
  plugin: createTelemetryPlugin({
    clickhouse: {
      url: process.env.TELEM_CLICKHOUSE_URL!,
      database: process.env.TELEM_CLICKHOUSE_DATABASE,
      username: process.env.TELEM_CLICKHOUSE_USERNAME,
      password: process.env.TELEM_CLICKHOUSE_PASSWORD,
    },
  }),
});
```

## Quick start — Legacy wrapper

```typescript
// lib/telemetry.ts (or wherever your route wrappers live)
import { initTelemetry, withTelemetry } from '@agentcash/telemetry';

initTelemetry({
  clickhouse: {
    url: process.env.TELEM_CLICKHOUSE_URL!,
    database: process.env.TELEM_CLICKHOUSE_DATABASE,
    username: process.env.TELEM_CLICKHOUSE_USERNAME,
    password: process.env.TELEM_CLICKHOUSE_PASSWORD,
  },
  verify: true, // optional — pings ClickHouse on startup, logs success/failure
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

## Four entrypoints

### Router Plugin (`@agentcash/telemetry/plugin`)

**Primary integration path.** Hooks into `@agentcash/router`'s orchestrate lifecycle.

Requires: `@clickhouse/client`

```typescript
import { createTelemetryPlugin } from '@agentcash/telemetry/plugin';
```

- `createTelemetryPlugin(config)` — returns a `RouterPlugin` that captures request metadata, payment verification, settlement, response, errors, alerts, and provider quota

### Core (`@agentcash/telemetry`)

Requires: `@clickhouse/client`, `next`

```typescript
import { initTelemetry, withTelemetry } from '@agentcash/telemetry';
```

- `initTelemetry(config)` — synchronous, call once at module level. Pass `verify: true` to ping ClickHouse on startup (fire-and-forget, never blocks)
- `withTelemetry(handler)` — wrap any Next.js route handler
- `extractVerifiedWallet(headers)` — extract wallet from x402 payment headers

### SIWX (`@agentcash/telemetry/siwx`)

Requires: `@x402/extensions`, `@x402/core`

```typescript
import { withSiwxTelemetry } from '@agentcash/telemetry/siwx';

export const GET = withSiwxTelemetry(async (request, ctx) => {
  // ctx.verifiedWallet is guaranteed to be set
  return NextResponse.json(await getJobs(ctx.verifiedWallet));
});
```

### Route Builder (`@agentcash/telemetry/builder`)

Requires: `@x402/next`, `zod` (^4), `@x402/extensions`

```typescript
import { createRouteBuilder } from '@agentcash/telemetry/builder';

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
import { initTelemetry, withTelemetry } from '@agentcash/telemetry';
initTelemetry({ clickhouse: { ... } });
export { withTelemetry };
```

```typescript
// instrumentation.ts — WRONG: singleton won't be shared with handlers
import { initTelemetry } from '@agentcash/telemetry';
export async function register() {
  initTelemetry({ clickhouse: { ... } }); // handlers can't see this
}
```

### Subpath exports isolate heavy deps

The `/siwx` and `/builder` entrypoints have additional peer dependencies. If you only use the core `withTelemetry` or `./plugin`, you don't need `zod`, `@x402/next`, or `@x402/extensions` installed.

### After updating, commit both `package.json` and lockfile

`pnpm update @agentcash/telemetry` bumps the version specifier in **both** `package.json` and `pnpm-lock.yaml`. Vercel's `frozen-lockfile` mode will reject deploys if only the lockfile is committed. Always:

```bash
git add package.json pnpm-lock.yaml
```

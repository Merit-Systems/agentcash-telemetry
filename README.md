# @merit-systems/x402-server-telemetry

[![npm](https://img.shields.io/npm/v/@merit-systems/x402-server-telemetry)](https://www.npmjs.com/package/@merit-systems/x402-server-telemetry)

Shared telemetry for Merit Systems x402 servers. Extracts identity headers, logs invocations to ClickHouse, and auto-extracts verified wallets from x402 payments and SIWX auth.

[Telemetry spec](docs/telemetry-spec.md) | [npm](https://www.npmjs.com/package/@merit-systems/x402-server-telemetry) | [GitHub](https://github.com/Merit-Systems/x402-server-telemetry)

## Quick start

```bash
npm install @merit-systems/x402-server-telemetry @clickhouse/client
```

```typescript
// instrumentation.ts
import { initTelemetry } from '@merit-systems/x402-server-telemetry';

initTelemetry({
  clickhouse: {
    url: process.env.TELEM_CLICKHOUSE_URL!,
    database: process.env.TELEM_CLICKHOUSE_DATABASE,
    username: process.env.TELEM_CLICKHOUSE_USERNAME,
    password: process.env.TELEM_CLICKHOUSE_PASSWORD,
  },
});
```

## Three APIs

**`withTelemetry`** — wrap any route handler:

```typescript
export const POST = withTelemetry(async (request, ctx) => {
  return NextResponse.json(await doWork(request));
});
```

**`withSiwxTelemetry`** — SIWX wallet auth + telemetry:

```typescript
export const GET = withSiwxTelemetry(async (request, ctx) => {
  return NextResponse.json(await getJobs(ctx.verifiedWallet));
});
```

**`createRouteBuilder`** — x402 pricing + Zod validation + telemetry:

```typescript
const route = createRouteBuilder({ x402Server });

export const POST = route
  .price('0.05', 'base:8453')
  .body(searchSchema)
  .handler(async ({ body }) => searchPeople(body.query));
```

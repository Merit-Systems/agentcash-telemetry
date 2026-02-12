# x402-server-telemetry

Shared telemetry package for Merit Systems x402 servers. Logs invocations to ClickHouse, extracts verified wallets from x402 payments and SIWX auth.

## Architecture

Three entrypoints via subpath exports:
- `.` (core) — `initTelemetry`, `withTelemetry`, `extractVerifiedWallet`. Deps: `@clickhouse/client`, `next`
- `./siwx` — `withSiwxTelemetry`. Deps: core + `@x402/extensions`, `@x402/core`
- `./builder` — `createRouteBuilder`, `HttpError`. Deps: core + `@x402/next`, `zod` (^4), `@x402/extensions`

Subpath exports exist to isolate peer deps. Consumers that only use `withTelemetry` don't need zod/x402 installed.

## Key files

- `src/index.ts` — core exports only
- `src/siwx.ts` — SIWX entrypoint (also exported as `./siwx`)
- `src/route-builder.ts` — route builder entrypoint (also exported as `./builder`)
- `src/clickhouse.ts` — ClickHouse singleton, `insertInvocation` (fire-and-forget)
- `src/init.ts` — `initTelemetry` (synchronous)
- `src/telemetry.ts` — `withTelemetry` wrapper
- `src/extract-wallet.ts` — wallet extraction from payment headers
- `src/types.ts` — shared types

## Critical rules

### No dynamic imports or require()
All imports are static. This was a hard-won lesson:
- `require()` compiles to broken `__require()` shim in tsup's ESM output
- `await import()` fails inside bundled code on Vercel
- Static imports + `serverExternalPackages: ['@clickhouse/client']` in the consumer is the only pattern that works reliably

### initTelemetry is synchronous
`createClient()` from `@clickhouse/client` is synchronous (connects lazily on first query). There is no reason for `initTelemetry` to be async.

### Never tell consumers to use instrumentation.ts
On Vercel serverless, `instrumentation.ts` runs in a separate module scope from route handlers. The ClickHouse client singleton set there is invisible to handlers. Always tell consumers to call `initTelemetry()` at module level in the same file that imports their route wrappers.

### Telemetry never affects responses
All ClickHouse logging is fire-and-forget, wrapped in try/catch. A telemetry failure must never cause a 500 or delay a response.

## Build

```bash
npm run check   # format + lint + typecheck + build
npm run build    # tsup only
```

tsup produces 3 entry points (index, siwx, builder) in both CJS and ESM with declarations. All peer deps are marked external.

## Consumers

- **enrichx402** — uses core + `./builder` (wraps `createRouteBuilder` in its own X402RouteBuilder)
- **stablestudio** — uses core + `./siwx` (wraps with `withTelemetry` and `withSiwxTelemetry`)

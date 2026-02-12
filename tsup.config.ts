import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    siwx: 'src/siwx.ts',
    builder: 'src/route-builder.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  // splitting: true is REQUIRED for subpath exports.
  // Without it, each entry point gets its own copy of the ClickHouse
  // singleton and initTelemetry() from ./index won't be visible to
  // insertInvocation() from ./builder or ./siwx.
  // Only works for ESM (CJS always inlines). Both consumers use ESM.
  splitting: true,
  sourcemap: true,
  external: [
    'next',
    '@clickhouse/client',
    '@x402/core',
    '@x402/next',
    '@x402/extensions',
    'zod',
  ],
});

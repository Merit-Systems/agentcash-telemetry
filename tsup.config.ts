import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: false,
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

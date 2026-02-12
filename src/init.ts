import type { TelemetryConfig } from './types';
import { initClickhouse } from './clickhouse';

let configuredOrigin: string | undefined;

/**
 * Initialize the telemetry package. Call once at module level.
 *
 * This is synchronous — createClient() does not connect until first query.
 *
 * IMPORTANT: On Vercel, instrumentation.ts runs in a separate module scope
 * from route handlers. Call this in the same module that imports your route
 * wrappers (withTelemetry, createRouteBuilder, etc.), NOT in instrumentation.ts.
 *
 * ```typescript
 * import { initTelemetry, withTelemetry } from '@merit-systems/x402-server-telemetry';
 *
 * initTelemetry({
 *   clickhouse: {
 *     url: process.env.TELEM_CLICKHOUSE_URL!,
 *     database: process.env.TELEM_CLICKHOUSE_DATABASE,
 *     username: process.env.TELEM_CLICKHOUSE_USERNAME,
 *     password: process.env.TELEM_CLICKHOUSE_PASSWORD,
 *   },
 * });
 * ```
 */
export function initTelemetry(config: TelemetryConfig): void {
  initClickhouse(config.clickhouse);
  if (config.origin) {
    configuredOrigin = config.origin;
  }
}

/** Get the configured origin, or undefined if not set. */
export function getOrigin(): string | undefined {
  return configuredOrigin;
}

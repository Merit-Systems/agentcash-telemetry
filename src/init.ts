import type { TelemetryConfig } from './types';
import { initClickhouse, setClickhouseClient } from './clickhouse';

let configuredOrigin: string | undefined;

/**
 * Initialize the telemetry package. Call once at app startup.
 *
 * Convention: use TELEM_CLICKHOUSE_* env vars to avoid collision
 * with app-level ClickHouse config.
 *
 * ```typescript
 * import { initTelemetry } from '@merit-systems/x402-server-telemetry';
 *
 * await initTelemetry({
 *   clickhouse: {
 *     url: process.env.TELEM_CLICKHOUSE_URL!,
 *     database: process.env.TELEM_CLICKHOUSE_DATABASE,
 *     username: process.env.TELEM_CLICKHOUSE_USERNAME,
 *     password: process.env.TELEM_CLICKHOUSE_PASSWORD,
 *   },
 *   origin: 'https://enrichx402.com', // optional, auto-detected from request if not set
 * });
 * ```
 */
export async function initTelemetry(config: TelemetryConfig): Promise<void> {
  if (config.clickhouseClient) {
    setClickhouseClient(config.clickhouseClient);
  } else {
    await initClickhouse(config.clickhouse);
  }
  if (config.origin) {
    configuredOrigin = config.origin;
  }
}

/** Get the configured origin, or undefined if not set. */
export function getOrigin(): string | undefined {
  return configuredOrigin;
}

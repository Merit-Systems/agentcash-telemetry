import { createClient } from '@clickhouse/client';
import type { McpResourceInvocation, TelemetryConfig } from './types';

let clickhouseClient: ReturnType<typeof createClient> | null = null;

const TABLE = 'mcp_resource_invocations';

/**
 * Initialize the ClickHouse client singleton.
 * createClient() is synchronous — no async needed.
 */
export function initClickhouse(config: TelemetryConfig['clickhouse']): void {
  clickhouseClient = createClient({
    url: config.url,
    database: config.database ?? 'default',
    username: config.username ?? 'default',
    password: config.password ?? '',
  });
}

/**
 * Fire-and-forget insert into mcp_resource_invocations.
 * Wrapped in try/catch — never throws, never blocks.
 */
export function insertInvocation(data: McpResourceInvocation): void {
  try {
    if (!clickhouseClient) {
      console.error(
        '[x402-telemetry] ClickHouse client not initialized. Call initTelemetry() first.',
      );
      return;
    }

    // Fire and forget — do NOT await
    clickhouseClient
      .insert<McpResourceInvocation>({
        table: TABLE,
        values: [data],
        format: 'JSONEachRow',
      })
      .catch((error: unknown) => {
        try {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[x402-telemetry] ClickHouse insert failed:', message);
        } catch {
          // Absolutely nothing escapes
        }
      });
  } catch (error: unknown) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[x402-telemetry] ClickHouse insert threw synchronously:', message);
    } catch {
      // Absolutely nothing escapes
    }
  }
}

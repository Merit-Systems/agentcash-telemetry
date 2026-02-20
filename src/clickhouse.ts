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
    // Serverless-safe defaults: disable keep-alive to prevent stale pooled
    // sockets after Lambda freeze/thaw, and shorten the request timeout since
    // inserts are fire-and-forget (a fast failure is fine).
    keep_alive: { enabled: false },
    request_timeout: 5_000,
  });
}

/**
 * Ping ClickHouse to verify the connection. Fire-and-forget, logs result.
 */
export function pingClickhouse(): void {
  if (!clickhouseClient) {
    console.error('[telemetry] Cannot verify: ClickHouse client not initialized.');
    return;
  }
  clickhouseClient
    .ping()
    .then((result) => {
      if (result.success) {
        console.log('[telemetry] ClickHouse connected');
      } else {
        console.error('[telemetry] ClickHouse ping failed');
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[telemetry] ClickHouse ping failed:', message);
    });
}

/**
 * Fire-and-forget insert into mcp_resource_invocations.
 * Wrapped in try/catch — never throws, never blocks.
 */
export function insertInvocation(data: McpResourceInvocation): void {
  try {
    if (!clickhouseClient) {
      console.error('[telemetry] ClickHouse client not initialized. Call initTelemetry() first.');
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
          console.error('[telemetry] ClickHouse insert failed:', message);
        } catch {
          // Absolutely nothing escapes
        }
      });
  } catch (error: unknown) {
    try {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[telemetry] ClickHouse insert threw synchronously:', message);
    } catch {
      // Absolutely nothing escapes
    }
  }
}

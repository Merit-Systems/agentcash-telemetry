/**
 * RouterPlugin adapter for @agentcash/router.
 *
 * Bridges the router's plugin hooks into ClickHouse telemetry.
 * Uses the same mcp_resource_invocations table as the legacy withTelemetry wrapper.
 *
 * Usage:
 *   import { createRouter } from '@agentcash/router';
 *   import { createTelemetryPlugin } from '@agentcash/telemetry/plugin';
 *
 *   const router = createRouter({
 *     payeeAddress: '...',
 *     plugin: createTelemetryPlugin({
 *       clickhouse: {
 *         url: process.env.TELEM_CLICKHOUSE_URL ?? 'http://localhost:8123',
 *         database: process.env.TELEM_CLICKHOUSE_DATABASE,
 *         username: process.env.TELEM_CLICKHOUSE_USERNAME,
 *         password: process.env.TELEM_CLICKHOUSE_PASSWORD,
 *       },
 *     }),
 *   });
 */

import { initClickhouse, pingClickhouse, insertInvocation } from './clickhouse';
import type { McpResourceInvocation, TelemetryConfig } from './types';

// ---------------------------------------------------------------------------
// Minimal RouterPlugin types (inlined to avoid depending on @agentcash/router
// at runtime — the router passes these shapes, we just consume them)
// ---------------------------------------------------------------------------

interface RequestMeta {
  requestId: string;
  method: string;
  route: string;
  origin: string;
  referer: string | null;
  walletAddress: string | null;
  clientId: string | null;
  sessionId: string | null;
  contentType: string | null;
  headers: Record<string, string>;
  startTime: number;
}

interface PluginContext {
  readonly requestId: string;
  readonly route: string;
  readonly walletAddress: string | null;
  readonly clientId: string | null;
  readonly sessionId: string | null;
  verifiedWallet: string | null;
  setVerifiedWallet(address: string): void;
}

interface PaymentEvent {
  protocol: 'x402' | 'mpp';
  payer: string;
  amount: string;
  network: string;
}

interface SettlementEvent {
  protocol: 'x402' | 'mpp';
  payer: string;
  transaction: string;
  network: string;
}

interface ResponseMeta {
  statusCode: number;
  statusText: string;
  duration: number;
  contentType: string | null;
  headers: Record<string, string>;
}

interface ErrorEvent {
  status: number;
  message: string;
  settled: boolean;
}

interface AlertEvent {
  level: string;
  message: string;
  route: string;
  meta?: Record<string, unknown>;
}

interface ProviderQuotaEvent {
  provider: string;
  route: string;
  remaining: number | null;
  limit: number | null;
  level: string;
  overage: string;
  message: string;
}

/** RouterPlugin interface — must match @agentcash/router's RouterPlugin */
interface RouterPlugin {
  init?(config: { origin?: string }): void | Promise<void>;
  onRequest?(meta: RequestMeta): PluginContext;
  onPaymentVerified?(ctx: PluginContext, payment: PaymentEvent): void;
  onPaymentSettled?(ctx: PluginContext, settlement: SettlementEvent): void;
  onResponse?(ctx: PluginContext, response: ResponseMeta): void;
  onError?(ctx: PluginContext, error: ErrorEvent): void;
  onAlert?(ctx: PluginContext, alert: AlertEvent): void;
  onProviderQuota?(ctx: PluginContext, event: ProviderQuotaEvent): void;
}

// ---------------------------------------------------------------------------
// Extended context — carries request metadata through the lifecycle
// ---------------------------------------------------------------------------

interface TelemetryPluginContext extends PluginContext {
  /** Stored from onRequest for use in onResponse */
  _meta: RequestMeta;
  /** Payment info captured between verify and response */
  _payment?: PaymentEvent;
  /** Settlement info captured between settle and response */
  _settlement?: SettlementEvent;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export interface TelemetryPluginConfig {
  clickhouse: TelemetryConfig['clickhouse'];
  /** If true, pings ClickHouse on init. */
  verify?: boolean;
  /** Console logging for dev. Default: false. */
  console?: boolean;
}

export function createTelemetryPlugin(config: TelemetryPluginConfig): RouterPlugin {
  // Initialize ClickHouse synchronously (connection happens on first query)
  initClickhouse(config.clickhouse);
  if (config.verify) {
    pingClickhouse();
  }

  const log = config.console ?? false;

  return {
    onRequest(meta: RequestMeta): PluginContext {
      const ctx: TelemetryPluginContext = {
        requestId: meta.requestId,
        route: meta.route,
        walletAddress: meta.walletAddress,
        clientId: meta.clientId,
        sessionId: meta.sessionId,
        verifiedWallet: null,
        setVerifiedWallet(address: string) {
          ctx.verifiedWallet = address;
        },
        _meta: meta,
      };
      return ctx as PluginContext;
    },

    onPaymentVerified(ctx: PluginContext, payment: PaymentEvent) {
      (ctx as TelemetryPluginContext)._payment = payment;
      if (log) {
        console.log(`[telemetry] VERIFIED ${payment.protocol} ${payment.payer} ${payment.amount}`);
      }
    },

    onPaymentSettled(ctx: PluginContext, settlement: SettlementEvent) {
      (ctx as TelemetryPluginContext)._settlement = settlement;
      if (log) {
        console.log(`[telemetry] SETTLED ${settlement.protocol} tx=${settlement.transaction}`);
      }
    },

    onResponse(ctx: PluginContext, response: ResponseMeta) {
      const tCtx = ctx as TelemetryPluginContext;
      const meta = tCtx._meta;

      if (log) {
        const wallet = ctx.verifiedWallet ? ` wallet=${ctx.verifiedWallet}` : '';
        console.log(
          `[telemetry] ${meta.route} → ${response.statusCode} (${response.duration}ms)${wallet}`,
        );
      }

      // 402 is the x402/MPP payment challenge — not a real invocation, skip logging
      if (response.statusCode === 402) {
        return;
      }

      const row: McpResourceInvocation = {
        id: meta.requestId,
        x_wallet_address: meta.walletAddress?.toLowerCase() ?? null,
        x_client_id: meta.clientId,
        session_id: meta.sessionId,
        verified_wallet_address: ctx.verifiedWallet?.toLowerCase() ?? null,

        method: meta.method,
        route: meta.route,
        origin: meta.origin,
        referer: meta.referer,
        request_content_type: meta.contentType,
        request_headers: JSON.stringify(meta.headers),
        request_body: null,

        status_code: response.statusCode,
        status_text: response.statusText,
        duration: response.duration,
        response_content_type: response.contentType,
        response_headers: JSON.stringify(response.headers),
        response_body: null,

        created_at: new Date(),
      };

      insertInvocation(row);
    },

    onError(ctx: PluginContext, error: ErrorEvent) {
      if (log) {
        console.error(`[telemetry] ERROR ${error.status}: ${error.message}`);
      }
    },

    onAlert(ctx: PluginContext, alert: AlertEvent) {
      if (log) {
        const logFn =
          alert.level === 'critical' || alert.level === 'error'
            ? console.error
            : alert.level === 'warn'
              ? console.warn
              : console.log;
        logFn(
          `[telemetry] ${alert.level.toUpperCase()} ${alert.route}: ${alert.message}`,
          alert.meta ?? '',
        );
      }
    },

    onProviderQuota(ctx: PluginContext, event: ProviderQuotaEvent) {
      if (log) {
        const logFn =
          event.level === 'critical'
            ? console.error
            : event.level === 'warn'
              ? console.warn
              : console.log;
        logFn(`[telemetry] QUOTA ${event.level.toUpperCase()} ${event.provider}: ${event.message}`);
      }
    },
  };
}

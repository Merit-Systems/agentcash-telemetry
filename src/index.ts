// Core — no optional deps required
export { initTelemetry } from './init';
export { withTelemetry } from './telemetry';
export { extractVerifiedWallet } from './extract-wallet';

// Types
export type { McpResourceInvocation, TelemetryContext, TelemetryConfig } from './types';

// SIWX and route builder are separate entrypoints:
//   import { withSiwxTelemetry } from '@merit-systems/x402-server-telemetry/siwx';
//   import { createRouteBuilder } from '@merit-systems/x402-server-telemetry/builder';

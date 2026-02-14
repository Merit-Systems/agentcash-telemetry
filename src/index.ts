// Core — no optional deps required
export { initTelemetry } from './init';
export { withTelemetry } from './telemetry';
export { extractVerifiedWallet } from './extract-wallet';

// Types
export type { McpResourceInvocation, TelemetryContext, TelemetryConfig } from './types';

// Separate entrypoints (optional peer deps isolated):
//   import { createTelemetryPlugin } from '@agentcash/telemetry/plugin';
//   import { withSiwxTelemetry } from '@agentcash/telemetry/siwx';
//   import { createRouteBuilder } from '@agentcash/telemetry/builder';

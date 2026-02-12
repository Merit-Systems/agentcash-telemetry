/**
 * SIWX telemetry wrapper — composes SIWX verification with telemetry.
 * One-liner for routes that need wallet auth + telemetry.
 *
 * Delegates SIWX verification to @x402/extensions/sign-in-with-x.
 * This package does NOT implement SIWX itself.
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { TelemetryContext } from './types';
import { withTelemetry } from './telemetry';

export interface SiwxTelemetryContext extends Omit<TelemetryContext, 'verifiedWallet'> {
  /** Verified wallet address from SIWX authentication */
  verifiedWallet: string;
}

type SiwxHandler = (request: NextRequest, ctx: SiwxTelemetryContext) => Promise<NextResponse>;

/**
 * Wrap a Next.js route handler with SIWX verification + telemetry.
 *
 * Verifies the SIGN-IN-WITH-X header and sets the verified wallet automatically.
 * If no SIWX header is present, returns a 402 with SIWX challenge.
 * If verification fails, returns a 401.
 *
 * Usage:
 * ```typescript
 * export const GET = withSiwxTelemetry(async (request, ctx) => {
 *   // ctx.verifiedWallet is guaranteed to be set
 *   return NextResponse.json(await getJobs(ctx.verifiedWallet));
 * });
 * ```
 */
export function withSiwxTelemetry(handler: SiwxHandler) {
  return withTelemetry(async (request: NextRequest, ctx: TelemetryContext) => {
    const header = request.headers.get('SIGN-IN-WITH-X') ?? request.headers.get('sign-in-with-x');

    if (!header) {
      // Return 402 with SIWX challenge
      return buildSiwxChallengeResponse(request);
    }

    // Lazy-load SIWX functions from @x402/extensions
    let siwx: typeof import('@x402/extensions/sign-in-with-x');
    try {
      siwx = await import('@x402/extensions/sign-in-with-x');
    } catch {
      console.error('[x402-telemetry] @x402/extensions not available for SIWX verification');
      return NextResponse.json(
        { success: false, error: 'SIWX verification not available' },
        { status: 500 },
      );
    }

    // Parse the header
    let payload: ReturnType<typeof siwx.parseSIWxHeader>;
    try {
      payload = siwx.parseSIWxHeader(header);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid SIGN-IN-WITH-X header' },
        { status: 401 },
      );
    }

    // Validate message fields
    const validation = await siwx.validateSIWxMessage(payload, request.url);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: `SIWX validation failed: ${validation.error}` },
        { status: 401 },
      );
    }

    // Verify the cryptographic signature
    const verification = await siwx.verifySIWxSignature(payload);
    if (!verification.valid || !verification.address) {
      return NextResponse.json(
        { success: false, error: 'SIWX signature verification failed' },
        { status: 401 },
      );
    }

    const walletAddress = verification.address.toLowerCase();
    ctx.setVerifiedWallet(walletAddress);

    return handler(request, {
      ...ctx,
      verifiedWallet: walletAddress,
    } as SiwxTelemetryContext);
  });
}

/**
 * Build a 402 response with SIWX challenge.
 * Matches the pattern used by x402email and stablestudio.
 */
function buildSiwxChallengeResponse(request: NextRequest): NextResponse {
  try {
    const { randomBytes } = require('crypto') as typeof import('crypto');
    const url = new URL(request.url);
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date().toISOString();
    const expirationTime = new Date(Date.now() + 300_000).toISOString();

    // Lazy-load extension helpers
    let buildSIWxSchema: () => unknown;
    let encodePaymentRequiredHeader: (body: unknown) => string;

    try {
      const siwx = require('@x402/extensions/sign-in-with-x') as {
        buildSIWxSchema: () => unknown;
      };
      buildSIWxSchema = siwx.buildSIWxSchema;
      const core = require('@x402/core/http') as {
        encodePaymentRequiredHeader: (body: unknown) => string;
      };
      encodePaymentRequiredHeader = core.encodePaymentRequiredHeader;
    } catch {
      // Extensions not available — return plain 402
      return NextResponse.json(
        { success: false, error: 'SIWX authentication required' },
        { status: 402 },
      );
    }

    const paymentRequired = {
      x402Version: 2,
      error: 'SIWX authentication required',
      resource: {
        url: request.url,
        description: 'SIWX-protected endpoint',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact' as const,
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '0',
          payTo: '0x0000000000000000000000000000000000000000',
          maxTimeoutSeconds: 300,
          extra: {},
        },
      ],
      extensions: {
        'sign-in-with-x': {
          info: {
            domain: url.hostname,
            uri: request.url,
            version: '1',
            nonce,
            issuedAt,
            expirationTime,
            statement: 'Sign in to verify your wallet identity',
            resources: [request.url],
          },
          supportedChains: [{ chainId: 'eip155:8453', type: 'eip191' }],
          schema: buildSIWxSchema(),
        },
      },
    };

    const encoded = encodePaymentRequiredHeader(paymentRequired);

    return new NextResponse(JSON.stringify(paymentRequired), {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': encoded,
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'SIWX authentication required' },
      { status: 402 },
    );
  }
}

/**
 * SIWX telemetry wrapper — composes SIWX verification with telemetry.
 * One-liner for routes that need wallet auth + telemetry.
 *
 * Delegates SIWX verification to @x402/extensions/sign-in-with-x.
 * This package does NOT implement SIWX itself.
 *
 * Import from '@merit-systems/x402-server-telemetry/siwx'.
 * Requires peer dep: @x402/extensions
 */

import { type NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import {
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
  buildSIWxSchema,
} from '@x402/extensions/sign-in-with-x';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { TelemetryContext } from './types';
import { withTelemetry } from './telemetry';

export type { SiwxTelemetryContext };

interface SiwxTelemetryContext extends Omit<TelemetryContext, 'verifiedWallet'> {
  /** Verified wallet address from SIWX authentication */
  verifiedWallet: string;
}

type SiwxHandler = (request: NextRequest, ctx: SiwxTelemetryContext) => Promise<NextResponse>;

/**
 * Wrap a Next.js route handler with SIWX verification + telemetry.
 *
 * Verifies the SIGN-IN-WITH-X header and sets the verified wallet automatically.
 * If no SIWX header is present, returns a 402 with SIWX challenge.
 * If verification fails, returns a 402 (matching x402 protocol convention).
 */
export function withSiwxTelemetry(handler: SiwxHandler) {
  return withTelemetry(async (request: NextRequest, ctx: TelemetryContext) => {
    const header = request.headers.get('SIGN-IN-WITH-X') ?? request.headers.get('sign-in-with-x');

    if (!header) {
      return buildSiwxChallengeResponse(request);
    }

    const payload = parseSIWxHeader(header);

    const validation = await validateSIWxMessage(payload, request.url);
    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: `SIWX validation failed: ${validation.error}` },
        { status: 402 },
      );
    }

    const verification = await verifySIWxSignature(payload);
    if (!verification.valid || !verification.address) {
      return NextResponse.json(
        { success: false, error: 'SIWX signature verification failed' },
        { status: 402 },
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
 */
function buildSiwxChallengeResponse(request: NextRequest): NextResponse {
  const url = new URL(request.url);
  const nonce = randomBytes(16).toString('hex');
  const issuedAt = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 300_000).toISOString();

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
        network: 'eip155:8453' as const,
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
}

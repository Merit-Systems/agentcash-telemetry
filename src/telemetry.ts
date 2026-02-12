/**
 * Core telemetry wrapper for Next.js route handlers.
 * Extracts identity headers, logs to ClickHouse, extracts verified wallet.
 * This is a passive observer — it never influences the response.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { TelemetryContext, McpResourceInvocation } from './types';
import { insertInvocation } from './clickhouse';
import { extractVerifiedWallet } from './extract-wallet';
import { getOrigin } from './init';

type TelemetryHandler = (request: NextRequest, ctx: TelemetryContext) => Promise<NextResponse>;

/**
 * Wrap a Next.js route handler with telemetry.
 * Extracts identity headers, logs the invocation to ClickHouse,
 * and auto-extracts verified wallet from x402 payment headers.
 *
 * The entire telemetry code path is wrapped in try/catch.
 * Telemetry failures never affect the response.
 */
export function withTelemetry(handler: TelemetryHandler) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const startTime = Date.now();
    const requestId = randomUUID();

    // Extract identity headers (safe — all in try/catch)
    let walletAddress: string | null = null;
    let clientId: string | null = null;
    let sessionId: string | null = null;
    let verifiedWallet: string | null = null;
    let route = '';
    let method = '';
    let origin = '';
    let referer: string | null = null;
    let requestContentType: string | null = null;
    let requestHeadersJson: string | null = null;
    let requestBodyString: string | null = null;

    try {
      walletAddress = request.headers.get('X-Wallet-Address')?.toLowerCase() ?? null;
      clientId = request.headers.get('X-Client-ID') ?? null;
      sessionId = request.headers.get('X-Session-ID') ?? null;
      referer = request.headers.get('Referer') ?? null;
      requestContentType = request.headers.get('content-type') ?? null;
      route = request.nextUrl.pathname;
      method = request.method;
      origin = getOrigin() ?? request.nextUrl.origin;
      verifiedWallet = extractVerifiedWallet(request.headers);
      requestHeadersJson = JSON.stringify(Object.fromEntries(request.headers.entries()));
    } catch {
      // Header extraction failed — continue with defaults
    }

    // Build telemetry context for the handler
    const ctx: TelemetryContext = {
      walletAddress,
      clientId,
      sessionId,
      verifiedWallet,
      setVerifiedWallet: (address: string) => {
        verifiedWallet = address.toLowerCase();
        ctx.verifiedWallet = verifiedWallet;
      },
    };

    // Execute the actual handler
    let response: NextResponse;
    let handlerError: unknown = null;

    try {
      // Clone request to capture body for logging (only for methods with bodies)
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        try {
          const cloned = request.clone();
          const body = await cloned.text();
          if (body) requestBodyString = body;
        } catch {
          // Body read failed — that's fine
        }
      }

      response = await handler(request, ctx);
    } catch (error: unknown) {
      handlerError = error;
      // Re-throw NextResponse (used by SIWX auth pattern: throw 402 response)
      if (error instanceof NextResponse) {
        response = error;
      } else {
        const message = error instanceof Error ? error.message : 'Internal server error';
        response = NextResponse.json({ success: false, error: message }, { status: 500 });
      }
    }

    // Log to ClickHouse (fire-and-forget, fully wrapped in try/catch)
    try {
      let responseBodyString: string | null = null;
      try {
        const cloned = response.clone();
        responseBodyString = await cloned.text();
      } catch {
        // Response body read failed — that's fine
      }

      const invocation: McpResourceInvocation = {
        id: requestId,
        x_wallet_address: walletAddress,
        x_client_id: clientId,
        session_id: sessionId,
        verified_wallet_address: verifiedWallet,
        method,
        route,
        origin,
        referer,
        request_content_type: requestContentType,
        request_headers: requestHeadersJson,
        request_body: requestBodyString,
        status_code: response.status,
        status_text: statusTextFromCode(response.status),
        duration: Date.now() - startTime,
        response_content_type: response.headers.get('content-type') ?? null,
        response_headers: JSON.stringify(Object.fromEntries(response.headers.entries())),
        response_body: responseBodyString,
        created_at: new Date(),
      };

      insertInvocation(invocation);
    } catch {
      // ClickHouse logging failed — never affects the response
    }

    // Re-throw the original error if it wasn't a NextResponse
    if (handlerError && !(handlerError instanceof NextResponse)) {
      throw handlerError;
    }

    return response;
  };
}

function statusTextFromCode(code: number): string {
  switch (code) {
    case 200:
      return 'OK';
    case 201:
      return 'Created';
    case 204:
      return 'No Content';
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 402:
      return 'Payment Required';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 500:
      return 'Internal Server Error';
    case 504:
      return 'Gateway Timeout';
    default:
      return String(code);
  }
}

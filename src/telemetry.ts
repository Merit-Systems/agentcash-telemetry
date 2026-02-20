/**
 * Core telemetry wrapper for Next.js route handlers.
 * Extracts identity headers, logs to ClickHouse, extracts verified wallet.
 * This is a passive observer — it never influences the response.
 */

import { type NextRequest, NextResponse } from 'next/server';
import type { TelemetryContext } from './types';
import { extractRequestMeta, buildTelemetryContext, recordInvocation } from './telemetry-core';

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
    const meta = extractRequestMeta(request);
    const ctx = buildTelemetryContext(meta);

    // Capture request body for logging (only for methods with bodies)
    let requestBodyString: string | null = null;
    if (meta.method === 'POST' || meta.method === 'PUT' || meta.method === 'PATCH') {
      try {
        const body = await request.clone().text();
        if (body) requestBodyString = body;
      } catch {
        // Body read failed — that's fine
      }
    }

    // Execute the actual handler
    let response: NextResponse;
    let handlerError: unknown = null;

    try {
      response = await handler(request, ctx);
    } catch (error: unknown) {
      handlerError = error;
      if (error instanceof NextResponse) {
        response = error;
      } else {
        const message = error instanceof Error ? error.message : 'Internal server error';
        response = NextResponse.json({ success: false, error: message }, { status: 500 });
      }
    }

    // Log to ClickHouse (fire-and-forget)
    let responseBodyString: string | null = null;
    try {
      responseBodyString = await response.clone().text();
    } catch {
      // Response body read failed — that's fine
    }

    // 402 is the x402/MPP payment challenge — not a real invocation, skip logging
    if (response.status !== 402) {
      recordInvocation(meta, requestBodyString, {
        status: response.status,
        body: responseBodyString,
        headers: JSON.stringify(Object.fromEntries(response.headers.entries())),
        contentType: response.headers.get('content-type') ?? null,
      });
    }

    // Re-throw the original error if it wasn't a NextResponse
    if (handlerError && !(handlerError instanceof NextResponse)) {
      throw handlerError;
    }

    return response;
  };
}

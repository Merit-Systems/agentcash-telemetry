/**
 * Convenience route builder that composes telemetry + validation + x402 wrapping.
 * This is optional — servers can use withTelemetry directly.
 *
 * Import from '@agentcash/telemetry/builder'.
 * Requires peer deps: @x402/next, zod (^4), @x402/extensions
 */

import { type NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { z, type ZodType } from 'zod';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import type { TelemetryContext } from './types';
import { extractRequestMeta, buildTelemetryContext, recordInvocation } from './telemetry-core';

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type AcceptsOption = {
  amount: string;
  network: string;
  asset?: string;
};

type BuilderConfig<TBody = unknown, TQuery = unknown, TOutput = unknown> = {
  accepts: AcceptsOption[];
  bodySchema?: ZodType<TBody>;
  querySchema?: ZodType<TQuery>;
  outputSchema?: ZodType<TOutput>;
  outputExample?: TOutput;
  description?: string;
};

type HandlerContext<TBody, TQuery> = {
  body: TBody;
  query: TQuery;
  request: NextRequest;
  telemetry: TelemetryContext;
};

type HandlerFn<TBody, TQuery, TResponse> = (
  ctx: HandlerContext<TBody, TQuery>,
) => Promise<TResponse>;

function formatValidationError(error: import('zod').ZodError): string {
  const issues = error.issues;
  if (issues.length === 0) return 'Validation failed';

  if (issues.length === 1) {
    const issue = issues[0];
    const path = issue.path.join('.');
    const field = path || 'request';
    if (issue.message) return `${field}: ${issue.message}`;
    return `${field}: Invalid value`;
  }

  const errors = issues.map((issue) => {
    const path = issue.path.join('.');
    const field = path || 'request';
    return issue.message ? `${field}: ${issue.message}` : `${field}: Invalid`;
  });

  return `Validation failed: ${errors.join('; ')}`;
}

export interface RouteBuilderOptions {
  /** The x402 resource server instance (from @x402/core/server). Required when using .price(). */
  x402Server?: unknown;
}

class RouteBuilder<TBody = unknown, TQuery = unknown, TOutput = unknown> {
  private config: BuilderConfig<TBody, TQuery, TOutput>;
  private options: RouteBuilderOptions;

  constructor(
    config?: Partial<BuilderConfig<TBody, TQuery, TOutput>>,
    options?: RouteBuilderOptions,
  ) {
    this.config = { accepts: [], ...config };
    this.options = options ?? {};
  }

  price(amount: string, network: string, asset?: string) {
    return new RouteBuilder<TBody, TQuery, TOutput>(
      { ...this.config, accepts: [{ amount, network, asset }] },
      this.options,
    );
  }

  accepts(options: AcceptsOption[]) {
    return new RouteBuilder<TBody, TQuery, TOutput>(
      { ...this.config, accepts: options },
      this.options,
    );
  }

  body<T>(schema: ZodType<T>) {
    return new RouteBuilder<T, TQuery, TOutput>(
      { ...this.config, bodySchema: schema as ZodType<unknown> } as BuilderConfig<
        T,
        TQuery,
        TOutput
      >,
      this.options,
    );
  }

  query<T>(schema: ZodType<T>) {
    return new RouteBuilder<TBody, T, TOutput>(
      { ...this.config, querySchema: schema as ZodType<unknown> } as BuilderConfig<
        TBody,
        T,
        TOutput
      >,
      this.options,
    );
  }

  output<T>(schema: ZodType<T>, example?: T) {
    return new RouteBuilder<TBody, TQuery, T>(
      {
        ...this.config,
        outputSchema: schema as ZodType<unknown>,
        outputExample: example,
      } as BuilderConfig<TBody, TQuery, T>,
      this.options,
    );
  }

  description(text: string) {
    return new RouteBuilder<TBody, TQuery, TOutput>(
      { ...this.config, description: text },
      this.options,
    );
  }

  handler<TResponse>(fn: HandlerFn<TBody, TQuery, TResponse>) {
    const { accepts, bodySchema, querySchema, outputSchema, outputExample, description } =
      this.config;

    const coreHandler = async (request: NextRequest): Promise<NextResponse> => {
      const meta = extractRequestMeta(request);
      const ctx = buildTelemetryContext(meta);

      const log = (status: number, responseBody: string | null, resp: NextResponse) => {
        recordInvocation(meta, requestBodyString, {
          status,
          body: responseBody,
          headers: JSON.stringify(Object.fromEntries(resp.headers.entries())),
          contentType: resp.headers.get('content-type') ?? null,
        });
      };

      // Parse and validate body
      let body: TBody = undefined as TBody;
      let query: TQuery = undefined as TQuery;
      let requestBodyString: string | null = null;

      if (bodySchema) {
        let rawBody: unknown;
        try {
          rawBody = await request.json();
          requestBodyString = JSON.stringify(rawBody);
        } catch {
          const errorResp = NextResponse.json(
            { success: false, error: 'Invalid JSON body' },
            { status: 400 },
          );
          log(400, JSON.stringify({ success: false, error: 'Invalid JSON body' }), errorResp);
          return errorResp;
        }

        const parsed = bodySchema.safeParse(rawBody);
        if (!parsed.success) {
          const message = formatValidationError(parsed.error);
          const errorBody = {
            success: false,
            error: 'Validation failed',
            message,
            details: parsed.error.flatten(),
          };
          const errorResp = NextResponse.json(errorBody, { status: 400 });
          log(400, JSON.stringify(errorBody), errorResp);
          return errorResp;
        }
        body = parsed.data;
      }

      // Parse and validate query
      if (querySchema) {
        const searchParams = Object.fromEntries(request.nextUrl.searchParams);
        const parsed = querySchema.safeParse(searchParams);
        if (!parsed.success) {
          const message = formatValidationError(parsed.error);
          const errorBody = {
            success: false,
            error: 'Query validation failed',
            message,
            details: parsed.error.flatten(),
          };
          const errorResp = NextResponse.json(errorBody, { status: 400 });
          log(400, JSON.stringify(errorBody), errorResp);
          return errorResp;
        }
        query = parsed.data;
      }

      // Execute user handler
      let response: TResponse;
      try {
        response = await fn({ body, query, request, telemetry: ctx });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        const status = error instanceof HttpError ? error.status : 500;
        const errorBody = { success: false, error: message };
        const errorResp = NextResponse.json(errorBody, { status });
        log(status, JSON.stringify(errorBody), errorResp);
        return errorResp;
      }

      // Detect { success: false } to prevent x402 settlement
      if (
        response &&
        typeof response === 'object' &&
        'success' in response &&
        !(response as { success: boolean }).success
      ) {
        const errorResp = NextResponse.json(response, { status: 500 });
        log(500, JSON.stringify(response), errorResp);
        return errorResp;
      }

      // Success
      const successResp = NextResponse.json(response);
      let responseBodyString: string | null = null;
      try {
        responseBodyString = JSON.stringify(response);
      } catch {
        // Not serializable — that's fine
      }
      log(200, responseBodyString, successResp);
      return successResp;
    };

    // If no pricing, return the core handler directly (no x402 wrapping)
    if (accepts.length === 0) {
      return coreHandler;
    }

    // Wrap with x402
    const X402_BYPASS = process.env.X402_BYPASS === 'true';
    if (X402_BYPASS) {
      return coreHandler;
    }

    const X402_PAYEE_ADDRESS = process.env.X402_PAYEE_ADDRESS;
    if (!X402_PAYEE_ADDRESS) {
      throw new Error('X402_PAYEE_ADDRESS environment variable is required when using .price()');
    }

    const routeConfig = {
      description,
      accepts: accepts.map(({ amount, network, asset }) => ({
        scheme: 'exact' as const,
        network: network as `${string}:${string}`,
        price: amount,
        payTo: X402_PAYEE_ADDRESS,
        ...(asset && { extra: { asset } }),
      })),
      extensions: buildDiscoveryExtensions(bodySchema, querySchema, outputSchema, outputExample),
    };

    if (!this.options.x402Server) {
      throw new Error(
        'x402Server is required when using .price(). Pass it to createRouteBuilder({ x402Server }).',
      );
    }

    return withX402(coreHandler, routeConfig, this.options.x402Server as never);
  }
}

function buildDiscoveryExtensions(
  bodySchema?: ZodType<unknown>,
  querySchema?: ZodType<unknown>,
  outputSchema?: ZodType<unknown>,
  outputExample?: unknown,
): Record<string, unknown> | undefined {
  const inputJsonSchema = bodySchema
    ? z.toJSONSchema(bodySchema, { target: 'draft-2020-12' })
    : querySchema
      ? z.toJSONSchema(querySchema, { target: 'draft-2020-12' })
      : undefined;

  const outputJsonSchema = outputSchema
    ? z.toJSONSchema(outputSchema, { target: 'draft-2020-12' })
    : undefined;

  if (!inputJsonSchema) return undefined;

  const config = {
    bodyType: bodySchema ? 'json' : undefined,
    inputSchema: inputJsonSchema,
    output: outputJsonSchema
      ? { schema: outputJsonSchema, example: outputExample ?? {} }
      : undefined,
  };

  return { ...declareDiscoveryExtension(config as never) };
}

/**
 * Create a new route builder instance.
 */
export function createRouteBuilder(options?: RouteBuilderOptions) {
  return new RouteBuilder(undefined, options);
}

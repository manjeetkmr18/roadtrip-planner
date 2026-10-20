import { applyDecorators } from '@nestjs/common';
import {
  ApiBasicAuth,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  type ApiResponseOptions,
} from '@nestjs/swagger';

export type ApiEndpointOptions = {
  tag: string;
  summary: string;
  description?: string;
  security?: 'bearer' | 'docs-basic';
  response?: ApiResponseOptions;
  errors?: number[];
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request',
  401: 'Authentication required',
  402: 'Plan limit reached',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  429: 'Rate limit exceeded',
  500: 'Internal server error',
  502: 'Upstream provider error',
  503: 'Service unavailable',
};

export function ApiEndpoint(options: ApiEndpointOptions): MethodDecorator {
  const success = options.response ?? { status: 200, description: 'Successful response' };
  const decorators: MethodDecorator[] = [
    ApiOperation({
      summary: options.summary,
      ...(options.description ? { description: options.description } : {}),
      tags: [options.tag],
    }),
    ApiResponse(success),
    ...(options.security === 'bearer' ? [ApiBearerAuth('bearer')] : []),
    ...(options.security === 'docs-basic' ? [ApiBasicAuth('docsBasic')] : []),
    ...(options.errors ?? []).map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? 'Request failed',
        schema: { type: 'object', additionalProperties: true },
      }),
    ),
  ];
  return applyDecorators(...decorators);
}

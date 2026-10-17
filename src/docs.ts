import { timingSafeEqual } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { TravelOptions, TravelOptionsQuery, TripPlan, TripRequest } from './core/index.js';
import type { Env } from './config/env.js';

/**
 * API documentation (OpenAPI 3.1 + Swagger UI) at /api/docs, with the raw spec at /api/docs-json.
 *
 * Both are behind HTTP Basic auth (DOCS_USERNAME / DOCS_PASSWORD). If either is unset the docs
 * are not mounted at all, so a deployment without them never exposes the API description.
 * Inside the docs, "Authorize" takes a user's Bearer token to try the signed-in endpoints.
 */

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
const out = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;

const Credentials = z.object({ email: z.email(), password: z.string().min(8).max(200), name: z.string().max(80).optional() });
const Login = Credentials.omit({ name: true });
const AuthResult = z.object({ token: z.string(), user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable().optional(), plan: z.string() }) });
const Me = z.object({ id: z.uuid(), email: z.string(), plan: z.string() });
const Status = z.enum(['draft', 'queued', 'generating', 'ready', 'failed']);
const TripListItem = z.object({ id: z.uuid(), title: z.string(), status: Status, startDate: z.string(), endDate: z.string(), updatedAt: z.string() });
const TripRecord = z.object({
  id: z.uuid(),
  title: z.string(),
  status: Status,
  request: TripRequest,
  plan: TripPlan.nullable(),
  error: z.string().nullable(),
  shareToken: z.string().nullable(),
  updatedAt: z.string(),
});
const Usage = z.object({ plan: z.string(), usedThisMonth: z.number(), limit: z.number().nullable() });
const Feedback = z.object({
  tripId: z.uuid().optional(),
  itemType: z.enum(['cost_line', 'stop', 'weather', 'road_event', 'other']),
  itemId: z.string().max(200).optional(),
  message: z.string().min(3).max(2000),
});
const ErrorBody = z.object({ statusCode: z.number(), message: z.unknown(), error: z.string().optional() });

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const body = (name: string) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });
const ok = (name: string, description = 'OK') => ({ description, content: { 'application/json': { schema: ref(name) } } });
const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description: { 400: 'Invalid input', 401: 'Missing or expired token', 402: 'Free-plan limit reached', 404: 'Not found', 409: 'Already exists', 429: 'Too many requests' }[c] ?? 'Error',
        content: { 'application/json': { schema: ref('Error') } },
      },
    ]),
  );
const secured = [{ bearer: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };

export function buildOpenApi(serverUrl?: string): OpenAPIObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Travlio API',
      version: '1.0.0',
      description:
        'Backend for the Travlio website and apps. Sign in with `POST /api/auth/login`, then use **Authorize** with the token to call the trip endpoints. ' +
        'Plans are generated in the background: `POST /trips/{id}/generate`, then poll `GET /trips/{id}` until `status` is `ready`.',
    },
    servers: [{ url: serverUrl ?? '/' }],
    tags: [
      { name: 'Auth', description: 'Accounts and tokens' },
      { name: 'Trips', description: 'Trips, plan generation and sharing (signed in)' },
      { name: 'Public', description: 'Shared trips and health (no token)' },
      { name: 'Feedback', description: '"Report incorrect info"' },
    ],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Credentials: json(Credentials),
        Login: json(Login),
        AuthResult: out(AuthResult),
        Me: out(Me),
        TripRequest: json(TripRequest),
        TripRecord: out(TripRecord),
        TripListItem: out(TripListItem),
        TripPlan: out(TripPlan),
        TravelOptionsQuery: json(TravelOptionsQuery),
        TravelOptions: out(TravelOptions),
        Usage: out(Usage),
        Feedback: json(Feedback),
        Error: out(ErrorBody),
      },
    },
    paths: {
      '/api/auth/register': { post: { tags: ['Auth'], summary: 'Create an account', requestBody: body('Credentials'), responses: { 201: ok('AuthResult', 'Account created'), ...errors(400, 409, 429) } } },
      '/api/auth/login': { post: { tags: ['Auth'], summary: 'Sign in', requestBody: body('Login'), responses: { 200: ok('AuthResult'), ...errors(400, 401, 429) } } },
      '/api/auth/me': { get: { tags: ['Auth'], summary: 'The signed-in user', security: secured, responses: { 200: ok('Me'), ...errors(401) } } },
      '/api/trips/travel-options': {
        post: {
          tags: ['Trips'],
          summary: 'Drive vs fly + drive, with flights for the dates',
          description: 'Checks whether the trip can be driven and how long it takes, recommends drive or fly + drive, and lists flights from the nearest airports (Duffel, or sample flights without DUFFEL_ACCESS_TOKEN). Not saved and not counted as a plan. Put a chosen flight in TripRequest.travel.',
          security: secured,
          requestBody: body('TravelOptionsQuery'),
          responses: { 200: ok('TravelOptions'), ...errors(400, 401, 429) },
        },
      },
      '/api/trips': {
        get: { tags: ['Trips'], summary: 'My trips', security: secured, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: ref('TripListItem') } } } }, ...errors(401) } },
        post: { tags: ['Trips'], summary: 'Create a trip (draft, not planned yet)', security: secured, requestBody: body('TripRequest'), responses: { 201: ok('TripRecord', 'Created'), ...errors(400, 401) } },
      },
      '/api/trips/usage': { get: { tags: ['Trips'], summary: 'Plans used this month and the free-plan limit', security: secured, responses: { 200: ok('Usage'), ...errors(401) } } },
      '/api/trips/{id}': {
        get: { tags: ['Trips'], summary: 'A trip with its plan', security: secured, parameters: [idParam], responses: { 200: ok('TripRecord'), ...errors(401, 404) } },
        put: { tags: ['Trips'], summary: 'Change a trip (re-plan with /generate)', security: secured, parameters: [idParam], requestBody: body('TripRequest'), responses: { 200: ok('TripRecord'), ...errors(400, 401, 404) } },
        delete: { tags: ['Trips'], summary: 'Delete a trip', security: secured, parameters: [idParam], responses: { 200: { description: 'Deleted' }, ...errors(401, 404) } },
      },
      '/api/trips/{id}/generate': {
        post: {
          tags: ['Trips'],
          summary: 'Plan or refresh a trip',
          description: 'Queues generation and returns the trip with status `queued`. Counts towards the monthly free-plan limit.',
          security: secured,
          parameters: [idParam],
          responses: { 201: ok('TripRecord', 'Queued'), ...errors(401, 402, 404) },
        },
      },
      '/api/trips/{id}/share': {
        post: { tags: ['Trips'], summary: 'Create a read-only share link', security: secured, parameters: [idParam], responses: { 201: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { shareToken: { type: 'string' } } } } } }, ...errors(401, 404) } },
      },
      '/api/share/{token}': {
        get: {
          tags: ['Public'],
          summary: 'A shared trip (read only)',
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, plan: ref('TripPlan'), updatedAt: { type: 'string' } } } } } }, ...errors(404) },
        },
      },
      '/api/feedback': { post: { tags: ['Feedback'], summary: 'Report incorrect info', security: secured, requestBody: body('Feedback'), responses: { 201: { description: 'Received' }, ...errors(400, 401) } } },
      '/api/health': { get: { tags: ['Public'], summary: 'Database and integrations status', responses: { 200: { description: 'OK' } } } },
    },
  } as unknown as OpenAPIObject;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when an Authorization header carries these Basic credentials (constant-time compare). */
export function basicAuthOk(header: string | undefined, username: string, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i > 0 && same(decoded.slice(0, i), username) && same(decoded.slice(i + 1), password);
}

/** HTTP Basic auth for the docs only. */
export function docsAuth(username: string, password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (basicAuthOk(req.headers.authorization, username, password)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="Travlio API docs", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    res.status(401).send('Authentication required');
  };
}

const SWAGGER_CDN = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

export function setupDocs(app: INestApplication, env: Env) {
  if (!env.DOCS_USERNAME || !env.DOCS_PASSWORD) {
    Logger.log('API docs are off (set DOCS_USERNAME and DOCS_PASSWORD to enable /api/docs)', 'Docs');
    return;
  }
  const guard = docsAuth(env.DOCS_USERNAME, env.DOCS_PASSWORD);
  // Protect the UI, its assets and the raw spec.
  app.use(['/api/docs', '/api/docs-json', '/api/docs-yaml'], guard);
  SwaggerModule.setup('api/docs', app, buildOpenApi(), {
    jsonDocumentUrl: 'api/docs-json',
    yamlDocumentUrl: 'api/docs-yaml',
    customSiteTitle: 'Travlio API docs',
    // Load Swagger UI from a CDN so serverless deployments don't need its files bundled.
    customCssUrl: `${SWAGGER_CDN}/swagger-ui.css`,
    customJs: [`${SWAGGER_CDN}/swagger-ui-bundle.js`, `${SWAGGER_CDN}/swagger-ui-standalone-preset.js`],
    swaggerOptions: { persistAuthorization: false, docExpansion: 'list', defaultModelsExpandDepth: 0 },
  });
  Logger.log('API docs at /api/docs (password protected)', 'Docs');
}

import { timingSafeEqual } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { TravelOptions, TravelOptionsQuery, TripAdjustmentRequest, TripPlan, TripRequest } from './core/index.js';
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
const AuthResult = z.object({ token: z.string(), user: z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable().optional(), plan: z.string(), emailVerified: z.boolean().optional() }) });
const Me = z.object({ id: z.uuid(), email: z.string(), name: z.string().nullable().optional(), plan: z.string(), emailVerified: z.boolean().optional() });
const VerifyEmail = z.object({ code: z.string().regex(/^\d{6}$/) });
const ForgotPassword = z.object({ email: z.email() });
const ResetPassword = z.object({ email: z.email(), code: z.string().regex(/^\d{6}$/), password: z.string().min(8).max(200) });
const UpdateProfile = z.object({ name: z.string().trim().min(1).max(80).nullable() });
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
const PlaceAutocomplete = z.object({
  q: z.string(),
  session: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});
const PlaceDetails = z.object({ id: z.string(), session: z.string().optional() });
const PlacePhoto = z.object({ placeId: z.string() });
const Checkout = z.object({ plan: z.enum(['monthly', 'annual']), idempotencyKey: z.uuid() });
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
        description: { 400: 'Invalid input', 401: 'Missing or expired token', 402: 'Free-plan limit reached', 403: 'Forbidden', 404: 'Not found', 409: 'Already exists', 429: 'Too many requests', 502: 'Upstream provider error', 503: 'Service unavailable' }[c] ?? 'Error',
        content: { 'application/json': { schema: ref('Error') } },
      },
    ]),
  );
const secured = [{ bearer: [] }];
const docsSecured = [{ docsBasic: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const adjustmentIdParam = { name: 'adjustmentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const tokenParam = { name: 'token', in: 'path', required: true, schema: { type: 'string' } };
const queryParam = (name: string, schema: Record<string, unknown>, required = true) => ({ name, in: 'query', required, schema });
const objectResult = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required });
const result = (schema: Record<string, unknown>, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

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
      { name: 'Users', description: 'Signed-in user profile' },
      { name: 'Membership', description: 'Subscription status and Stripe billing' },
      { name: 'Places', description: 'Place autocomplete, details, and photos' },
      { name: 'Health', description: 'Service health and integration diagnostics' },
      { name: 'Public', description: 'Shared trips and public endpoints (no token)' },
      { name: 'Feedback', description: '"Report incorrect info"' },
    ],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        docsBasic: { type: 'http', scheme: 'basic', description: 'DOCS_USERNAME and DOCS_PASSWORD' },
      },
      schemas: {
        Credentials: json(Credentials),
        Login: json(Login),
        AuthResult: out(AuthResult),
        Me: out(Me),
        VerifyEmail: json(VerifyEmail),
        ForgotPassword: json(ForgotPassword),
        ResetPassword: json(ResetPassword),
        UpdateProfile: json(UpdateProfile),
        TripRequest: json(TripRequest),
        TripRecord: out(TripRecord),
        TripListItem: out(TripListItem),
        TripPlan: out(TripPlan),
        TravelOptionsQuery: json(TravelOptionsQuery),
        TravelOptions: out(TravelOptions),
        Usage: out(Usage),
        TripAdjustmentRequest: json(TripAdjustmentRequest),
        PlaceAutocomplete: json(PlaceAutocomplete),
        PlaceDetails: json(PlaceDetails),
        PlacePhoto: json(PlacePhoto),
        Checkout: json(Checkout),
        Feedback: json(Feedback),
        Error: out(ErrorBody),
      },
    },
    paths: {
      '/api/auth/register': { post: { tags: ['Auth'], summary: 'Create an account', requestBody: body('Credentials'), responses: { 201: ok('AuthResult', 'Account created'), ...errors(400, 409, 429) } } },
      '/api/auth/login': { post: { tags: ['Auth'], summary: 'Sign in', requestBody: body('Login'), responses: { 200: ok('AuthResult'), ...errors(400, 401, 429) } } },
      '/api/auth/me': { get: { tags: ['Auth'], summary: 'The signed-in user', security: secured, responses: { 200: ok('Me'), ...errors(401) } } },
      '/api/auth/verify-email': { post: { tags: ['Auth'], summary: 'Verify the signed-in account email', security: secured, requestBody: body('VerifyEmail'), responses: { 200: ok('AuthResult'), ...errors(400, 401, 409, 429) } } },
      '/api/auth/resend-verification': { post: { tags: ['Auth'], summary: 'Resend the email verification code', security: secured, responses: { 200: { description: 'Code sent or account already verified' }, ...errors(401, 429) } } },
      '/api/auth/forgot-password': { post: { tags: ['Auth'], summary: 'Request a password reset code', requestBody: body('ForgotPassword'), responses: { 200: { description: 'Same response whether or not the email exists' }, ...errors(400, 429) } } },
      '/api/auth/reset-password': { post: { tags: ['Auth'], summary: 'Reset password using the emailed code', requestBody: body('ResetPassword'), responses: { 200: ok('AuthResult'), ...errors(400, 429) } } },
      '/api/users/me': {
        get: { tags: ['Users'], summary: 'Get the signed-in user profile', security: secured, responses: { 200: ok('Me'), ...errors(401, 404) } },
        patch: { tags: ['Users'], summary: 'Update the profile name', security: secured, requestBody: body('UpdateProfile'), responses: { 200: ok('Me'), ...errors(400, 401, 404) } },
      },
      '/api/membership/plans': {
        get: { tags: ['Membership'], summary: 'Get configured recurring Stripe prices', description: 'Requires Stripe prices to be configured. Returns monthly and annual price IDs, amount, currency, and interval.', responses: { 200: result({ type: 'array', items: objectResult({ code: { type: 'string' }, priceId: { type: 'string' }, amount: { type: ['number', 'null'] }, currency: { type: 'string' }, interval: { type: 'string' }, intervalCount: { type: 'integer' } }) }), ...errors(503) } },
      },
      '/api/membership/me': {
        get: { tags: ['Membership'], summary: 'Get effective membership and latest subscription status', security: secured, responses: { 200: result(objectResult({ plan: { type: 'string', enum: ['free', 'pro'] }, subscription: { anyOf: [objectResult({ plan: { type: 'string' }, status: { type: 'string' }, currentPeriodStart: { type: ['string', 'null'], format: 'date-time' }, currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' }, cancelAtPeriodEnd: { type: 'boolean' } }), { type: 'null' }] } })), ...errors(401) } },
      },
      '/api/membership/usage': {
        get: { tags: ['Membership'], summary: 'Get monthly generation usage', security: secured, responses: { 200: ok('Usage'), ...errors(401) } },
      },
      '/api/membership/checkout': {
        post: { tags: ['Membership'], summary: 'Create or reuse a Stripe Checkout session', security: secured, requestBody: body('Checkout'), responses: { 201: result(objectResult({ url: { type: 'string', format: 'uri' } }), 'Checkout session created'), ...errors(400, 401, 403, 409, 503) } },
      },
      '/api/membership/portal': {
        post: { tags: ['Membership'], summary: 'Create a Stripe customer portal session', security: secured, responses: { 201: result(objectResult({ url: { type: 'string', format: 'uri' } }), 'Portal session created'), ...errors(401, 403, 409, 503) } },
      },
      '/api/membership/webhook': {
        post: { tags: ['Membership'], summary: 'Receive Stripe subscription webhook events', description: 'Configure Stripe to send checkout.session.completed and customer.subscription.created, customer.subscription.updated, and customer.subscription.deleted. Requires the raw request body and a valid Stripe-Signature header.', parameters: [{ name: 'Stripe-Signature', in: 'header', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: result(objectResult({ received: { type: 'boolean' }, duplicate: { type: 'boolean' } })), ...errors(400, 503) } },
      },
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
      '/api/trips/saved-stops/nearby': {
        get: { tags: ['Trips'], summary: 'Find saved stops near a location', description: 'Searches the signed-in user’s saved trip stops. radiusKm defaults to 25 and is capped at 200.', security: secured, parameters: [queryParam('lat', { type: 'number', minimum: -90, maximum: 90 }), queryParam('lng', { type: 'number', minimum: -180, maximum: 180 }), queryParam('radiusKm', { type: 'number', exclusiveMinimum: 0, maximum: 200 }, false)], responses: { 200: result({ type: 'array', items: { type: 'object', additionalProperties: true } }), ...errors(400, 401) } },
      },
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
      '/api/trips/{id}/adjustments/preview': {
        post: { tags: ['Trips'], summary: 'Preview a late-arrival lodging adjustment (Pro only)', description: 'Supports one-way drive trips reaching the destination on the final driving day. Requires active Pro membership. The preview may incur Google Maps/provider costs. Apply only after reviewing the returned plan.', security: secured, parameters: [idParam], requestBody: body('TripAdjustmentRequest'), responses: { 201: result(objectResult({ id: { type: 'string', format: 'uuid' }, plan: ref('TripPlan'), summary: { type: 'object', additionalProperties: true } }), 'Adjustment preview created'), ...errors(400, 401, 403, 404, 409) } },
      },
      '/api/trips/{id}/adjustments/{adjustmentId}/apply': {
        post: { tags: ['Trips'], summary: 'Apply a previously previewed itinerary adjustment', description: 'Applies only if the trip still matches the version used for the preview.', security: secured, parameters: [idParam, adjustmentIdParam], responses: { 201: result(objectResult({ applied: { type: 'boolean' }, plan: ref('TripPlan') })), ...errors(401, 404, 409) } },
      },
      '/api/trips/{id}/adjustments/{adjustmentId}/undo': {
        post: { tags: ['Trips'], summary: 'Undo an applied itinerary adjustment', description: 'Restores the previous plan only if the adjusted plan is still current.', security: secured, parameters: [idParam, adjustmentIdParam], responses: { 201: result(objectResult({ undone: { type: 'boolean' }, plan: ref('TripPlan') })), ...errors(401, 404, 409) } },
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
      '/api/places/autocomplete': {
        get: { tags: ['Places'], summary: 'Suggest matching places', description: 'Can be called signed out; unauthenticated callers have a tighter per-IP request limit. Pass the returned session token to details.', parameters: [queryParam('q', { type: 'string', minLength: 1, maxLength: 120 }), queryParam('session', { type: 'string' }, false), queryParam('lat', { type: 'number', minimum: -90, maximum: 90 }, false), queryParam('lng', { type: 'number', minimum: -180, maximum: 180 }, false)], responses: { 200: result(objectResult({ live: { type: 'boolean' }, suggestions: { type: 'array', items: { type: 'object', additionalProperties: true } } })), ...errors(400, 429, 502) } },
      },
      '/api/places/details': {
        get: { tags: ['Places'], summary: 'Resolve a Google place ID to address and coordinates', parameters: [queryParam('id', { type: 'string', pattern: '^[A-Za-z0-9_-]{10,300}$' }), queryParam('session', { type: 'string' }, false)], responses: { 200: result(objectResult({ placeId: { type: 'string' }, address: { type: 'string' }, location: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] } })), ...errors(400, 429, 502) } },
      },
      '/api/places/photo': {
        get: { tags: ['Places'], summary: 'Get photo metadata for a place', parameters: [queryParam('placeId', { type: 'string', pattern: '^[A-Za-z0-9_-]{10,300}$' })], responses: { 200: result(objectResult({ photo: { type: 'object', additionalProperties: true } })), ...errors(400, 429, 502) } },
      },
      '/api/feedback': { post: { tags: ['Feedback'], summary: 'Report incorrect info', security: secured, requestBody: body('Feedback'), responses: { 201: { description: 'Received' }, ...errors(400, 401) } } },
      '/api/health': {
        get: { tags: ['Health'], summary: 'Lightweight API and database health check', description: 'Does not call paid external providers. HTTP 200 may still have ok=false if the database is unavailable.', responses: { 200: result(objectResult({ ok: { type: 'boolean' }, db: { type: 'boolean' }, queue: { type: 'string', enum: ['inline', 'bullmq'] }, providers: { type: 'object', additionalProperties: { type: 'boolean' } } })) } },
      },
      '/api/health/integrations': {
        get: { tags: ['Health'], summary: 'Run live integration diagnostics', description: 'Protected by DOCS_USERNAME and DOCS_PASSWORD. Performs real provider calls, including Google and Bedrock where configured, and may incur provider costs. A provider status of off means it was not configured or live mode is disabled.', security: docsSecured, responses: { 200: result(objectResult({ ok: { type: 'boolean' }, checkedAt: { type: 'string', format: 'date-time' }, summary: objectResult({ ok: { type: 'integer' }, fail: { type: 'integer' }, off: { type: 'integer' } }), results: { type: 'array', items: objectResult({ name: { type: 'string' }, status: { type: 'string', enum: ['ok', 'fail', 'off'] }, ms: { type: 'number' }, detail: { type: 'string' } }) } })), ...errors(401, 404) } },
      },
      '/api/health/test-account': {
        post: { tags: ['Health'], summary: 'Create a verified throwaway account for API smoke tests', description: 'Protected by DOCS_USERNAME and DOCS_PASSWORD. Intended only for the project API smoke-test workflow.', security: docsSecured, responses: { 201: ok('AuthResult', 'Test account created'), ...errors(401, 404, 503) } },
      },
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

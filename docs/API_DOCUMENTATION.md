# API Documentation

The API exposes password-protected Swagger UI at `/api/docs` and the OpenAPI JSON at `/api/docs-json`. Documentation is enabled when both `DOCS_USERNAME` and `DOCS_PASSWORD` are configured.

## Reusable endpoint decorator

Use `ApiEndpoint` on every controller method to describe its tag, summary, security, success status, and common error responses. The decorator applies Nest Swagger metadata in one place:

```ts
@Get('me')
@UseGuards(JwtGuard)
@ApiEndpoint({
  tag: 'Users',
  summary: 'Get the signed-in user profile',
  security: 'bearer',
  errors: [401, 404],
})
getProfile(@CurrentUser() user: AuthUser) {
  return this.users.getProfile(user.id);
}
```

For write operations, set the success status explicitly when it is not the default `200`:

```ts
@Post()
@ApiEndpoint({
  tag: 'Trips',
  summary: 'Create a trip draft',
  security: 'bearer',
  response: { status: 201, description: 'Trip draft created' },
  errors: [400, 401, 403],
})
create() {
  // ...
}
```

Use `security: 'docs-basic'` for routes protected by the API documentation credentials, and omit `security` for public routes. The decorator adds shared error descriptions; endpoint-specific request/response schemas and detailed examples can still be added using `@ApiBody`, `@ApiResponse`, or the existing Zod-backed OpenAPI specification.

At startup, Swagger discovers decorated controllers and merges the generated paths with the curated specification in `src/docs.ts`. The curated request/response schemas remain authoritative for existing routes, while newly added decorated routes are included automatically rather than silently missing from the docs.

`src/docs.ts` remains the place to document detailed Zod schemas, special parameters, provider-cost warnings, and manually configured behavior.

# Personal trip assistant and late-arrival adjustments

## Conversational personal assistant

The web trip screen offers a Pro-only chat assistant for all trip types: one-way or round-trip, drive-only or fly-and-drive. It can propose preference changes such as pace, daily driving hours, interests, detours, parking, ferry avoidance, creator mode, and personal planning notes. It does not change the route, dates, trip type, airports, or flight details, and it never books anything.

### API

- `POST /api/trips/:id/assistant` accepts up to 12 bounded chat messages and an optional draft request. It returns a response and either a validated preference proposal or a clarification. It requires an authenticated, verified trip owner, Pro entitlement (administrators included), and a configured Bedrock model.
- `POST /api/trips/:id/assistant/apply` accepts the proposed trip request and the `baseGeneratedAt` version shown to the assistant. It atomically checks the plan version and monthly planning quota before saving preferences and queueing a new plan. The existing request and plan are not changed if quota admission fails.

The assistant may send traveller messages and trip context to the configured Bedrock provider. Do not include sensitive personal data in chat. Its suggestions are not guaranteed facts; the traveller reviews and confirms each proposal. Confirmed `personalInstructions` are passed to stop selection as untrusted preferences, while the planner continues to constrain selected places to known candidates.

The trip screen also offers a separate **Adjust arrival lodging** action for eligible one-way drive trips. The traveller selects lodging, confirms the estimated arrival time, and chooses when to resume the next day. The app previews the exact changes before applying them.

## API

All endpoints require an authenticated, email-verified owner of the trip. Preview additionally requires an active Travlio Pro membership or an administrator role persisted in the database. The API checks entitlement before making any geocoding, routing, road-event, or cost-provider calls; an ineligible free account receives `403 Forbidden`. Apply and undo remain available for an existing proposal so membership changes cannot strand an in-progress adjustment.

### Preview

`POST /api/trips/:id/adjustments/preview`

```json
{
  "arrivalDay": 4,
  "arrivalTime": "21:00",
  "resumeTime": "10:00",
  "accommodation": {
    "address": "Example hotel, Calgary, AB",
    "placeId": "Google Place ID"
  }
}
```

The API resolves the lodging server-side, checks it is within 100 km of the planned destination, and calculates the destination-to-lodging route. The response contains a proposal ID, the proposed plan, removed stop names, added distance and driving time, estimated lodging arrival, and any sample-data indicator.

The proposal removes sightseeing, meal, and rest stops from the final destination-arrival day while preserving fuel and traveller-added waypoints. It adds a city-arrival marker and a lodging overnight stop, extends each route option and its cost estimate, and moves subsequent destination days to start from the lodging at the selected resume time. Weather remains destination-area data; road events are checked for the added lodging leg.

### Apply and undo

- `POST /api/trips/:id/adjustments/:adjustmentId/apply`
- `POST /api/trips/:id/adjustments/:adjustmentId/undo`

Apply is conditional on the plan still matching the version used to make the preview. If another change happened meanwhile, the API rejects the stale proposal rather than overwriting the newer plan. Undo is also conditional on the adjusted plan still being current. The previous plan is retained in `trip_adjustments`.

## Arrival-adjustment MVP boundaries

- Supports only one-way, drive-mode trips, on the final driving day that reaches the destination.
- Lodging must be within 100 km of the destination. This scopes the added route to the final arrival leg; it does not regenerate the earlier trip route.
- Does not book accommodation. Arrival and resume times are traveller-provided estimates.
- The lodging quick-action remains a structured preview, separate from the conversational personal assistant.
- Preview is a Pro-only feature because it may incur mapping and route-provider costs. Administrators receive Pro entitlement for testing, and provider calls can still incur costs.
- The web app displays the personal assistant entry point for every planned trip; free users are directed to membership options.
- The lodging picker searches Google Places for nearby lodging. It requires live Google Places configuration (`GOOGLE_MAPS_API_KEY` and `PROVIDER_MODE=auto`); without it, no real hotel listings are available and the traveller can enter an address manually.
- Existing forecasts and advisories are retained from the original destination-area plan; the UI explicitly labels this.

Apply database migration `drizzle/0004_trip_adjustments.sql` before enabling these endpoints in an environment that has not applied it.

# Late-arrival itinerary adjustments

The trip screen in the Expo app and web app offers an **Arriving late? Go to lodging first** action for one-way drive trips. The traveller selects lodging, confirms the estimated arrival time, and chooses when to resume the next day. The app previews the exact changes before applying them.

## API

All endpoints require an authenticated, email-verified owner of the trip. Preview additionally requires an active Travlio Pro membership. The API checks the persisted subscription status and period end before making any geocoding, routing, road-event, or cost-provider calls; a free account receives `403 Forbidden`. Apply and undo remain available for an existing proposal so membership changes cannot strand an in-progress adjustment.

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

## Current MVP boundaries

- Supports only one-way, drive-mode trips, on the final driving day that reaches the destination.
- Lodging must be within 100 km of the destination. This scopes the added route to the final arrival leg; it does not regenerate the earlier trip route.
- Does not book accommodation. Arrival and resume times are traveller-provided estimates.
- It is a structured quick-action flow, not a free-form AI chatbot. It does not send chat text or trip details to Bedrock.
- Preview is a Pro-only feature because it may incur mapping and route-provider costs. It currently does not call an AI model.
- Existing forecasts and advisories are retained from the original destination-area plan; the UI explicitly labels this.

Apply database migration `drizzle/0004_trip_adjustments.sql` before enabling these endpoints in an environment that has not applied it.

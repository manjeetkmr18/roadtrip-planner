# Trip Place Images — Client UI Integration

This document describes the client-side work needed to display images for recommended trip stops. The API is implemented in this repository. The Next.js web app now resolves and displays images and attribution in itinerary stop cards (including its narrow/mobile layout); the native Expo app still needs the equivalent UI integration.

## API contract

Generated Google-backed stops may include an optional `photosUrl` field. Sample-data stops and stops without a Google Place ID may omit it.

```json
{
  "id": "ChIJ...",
  "name": "Example attraction",
  "photosUrl": "/api/places/photo?placeId=ChIJ..."
}
```

Request the URL relative to the configured API origin:

```http
GET /api/places/photo?placeId=<Google Place ID>
```

Successful response:

```json
{
  "photo": {
    "url": "https://lh3.googleusercontent.com/...",
    "attributions": [
      {
        "displayName": "Photo author",
        "uri": "https://..."
      }
    ]
  }
}
```

`photo` may be `null` when Google has no photo available. The URL is temporary and the endpoint responds with `Cache-Control: no-store`; resolve it when the stop card is displayed rather than persisting it. A missing `photosUrl`, `photo: null`, failed request, or failed image load should all produce the ordinary no-image card state, not a broken-image icon.

The endpoint accepts either an authenticated request or a rate-limited anonymous request. If the app has a session token, send it as a Bearer token using the same API client/interceptor used for trip requests. Do not add the Google API key to the client.

## UI implementation checklist

- [x] Web: In itinerary stop cards, check for `photosUrl`; stops without it retain the existing layout.
- [x] Web: Resolve photo metadata only as cards approach the viewport, using the configured API base URL and authenticated API client.
- [x] Web: Reserve a 16:9 skeleton frame while loading; hide it gracefully for null photos, request errors, or image-load failures.
- [x] Web: Render the temporary URL directly, show author attribution and Google Maps attribution, and provide the stop name as alt text.
- [x] Web: Do not persist the temporary photo URL; load images directly without Next.js image optimization.
- [x] Web: Use the same itinerary component for owned and shared trip plans.
- [ ] Native Expo app: Add equivalent lazy loading, fallbacks, attribution, and accessible image text.
- [ ] Test cards with a photo, no `photosUrl`, a `null` photo, endpoint error, image error, missing author link, and multiple authors if returned.
- [ ] Check narrow mobile and wide desktop layouts, dark/light backgrounds, keyboard navigation, and screen-reader labels.

## Request lifecycle example

Use the application's existing HTTP client; this outline is framework-neutral:

```ts
const response = await apiClient.get(stop.photosUrl);
const photo = response.data.photo;

if (photo) {
  // Render photo.url and photo.attributions for this visible stop card.
} else {
  // Keep the card's no-image placeholder.
}
```

Do not assume this image URL is stable, and do not treat a photo lookup failure as a trip-generation failure.

## Validation before release

- [ ] With `GOOGLE_MAPS_API_KEY` enabled, generate a live trip and confirm recommended stop cards with `photosUrl` display an image and its attribution.
- [ ] In sample mode or when Google returns no photo, confirm the itinerary remains usable and cards fall back cleanly.
- [ ] Confirm the browser/network request goes to the API endpoint first; the Google key is not present in client requests or bundles.
- [ ] Confirm the returned photo author attribution and Google Maps attribution remain visible at all supported breakpoints.
- [ ] Review current Google Places photo policies before release: <https://developers.google.com/maps/documentation/places/web-service/policies>.

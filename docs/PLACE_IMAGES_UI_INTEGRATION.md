# Trip Place Images — Client UI Integration

This document describes the client-side work needed to display images for recommended trip stops. The API is implemented in this repository; the trip-screen UI is in the client application and must be updated separately.

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

- [ ] In the itinerary/trip stop card, check for `photosUrl`; if absent, keep the existing card layout and placeholder.
- [ ] On card visibility, request `photosUrl` using the configured API base URL and the app's standard HTTP client. Avoid requesting images for every stop at once on long plans; use lazy loading or fetch as cards approach the viewport.
- [ ] Show the existing placeholder/skeleton while metadata loads. Handle request failure, `photo: null`, invalid response, and image-load error with the same graceful no-image fallback.
- [ ] Render `photo.url` as the image source. Preserve aspect ratio with a consistent crop/contain policy, and avoid layout shift by reserving the image frame's dimensions.
- [ ] Display each `attributions[].displayName` alongside the image. When `uri` is present, make the attribution a link and open external URLs safely (`noopener`/`noreferrer` on web).
- [ ] Include the Google Maps logo/text attribution whenever Google Places content is shown outside a Google Map. Keep both Google's and the photo author's attribution visible and legible against the card/image.
- [ ] Add accessible image text (for example, the stop name as alt text); mark decorative placeholders appropriately.
- [ ] Do not save the returned temporary `photo.url` to local storage, a database, trip state persisted across sessions, analytics events, or a general-purpose image cache. Do not save raw Google photo references. Store/use the stop's `photosUrl` and place ID only.
- [ ] Ensure shared-trip pages use the same attribution and error/placeholder behavior as owned trip pages.
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

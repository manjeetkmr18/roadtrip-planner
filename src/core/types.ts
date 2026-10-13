import { z } from 'zod';

/** How much a number can be trusted. Shown next to every cost and fact in the UI. */
export const Confidence = z.enum([
  'verified', // official published rate applied exactly
  'provider_estimate', // a provider's computed estimate (e.g. Google tolls)
  'approximate', // our own calculation with stated assumptions
  'unknown', // we know a cost exists but not its amount
]);
export type Confidence = z.infer<typeof Confidence>;

export const SourceRef = z.object({
  name: z.string(),
  url: z.string().optional(),
  retrievedAt: z.string(), // ISO timestamp
});
export type SourceRef = z.infer<typeof SourceRef>;

export const Currency = z.enum(['CAD', 'USD']);
export type Currency = z.infer<typeof Currency>;

export const LatLng = z.object({ lat: z.number(), lng: z.number() });
export type LatLng = z.infer<typeof LatLng>;

export const PlaceInput = z.object({
  address: z.string().min(2),
  location: LatLng.optional(),
  placeId: z.string().optional(),
});
export type PlaceInput = z.infer<typeof PlaceInput>;

export const FuelType = z.enum(['gasoline', 'diesel', 'hybrid', 'electric']);
export type FuelType = z.infer<typeof FuelType>;

export const Pace = z.enum(['relaxed', 'balanced', 'packed']);
export type Pace = z.infer<typeof Pace>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');

export const VehicleInput = z.object({
  fuelType: FuelType.default('gasoline'),
  /** L/100km for fuel vehicles, kWh/100km for EVs. */
  consumptionPer100km: z.number().positive().max(60).default(8.5),
  has407Transponder: z.boolean().default(false),
  /** Google Routes TollPass enum values the driver holds, e.g. US_NY_EZPASSNY. */
  tollPasses: z.array(z.string()).default([]),
});
export type VehicleInput = z.infer<typeof VehicleInput>;

export const PreferencesInput = z.object({
  pace: Pace.default('balanced'),
  maxDrivingHoursPerDay: z.number().min(1).max(14).default(6),
  interests: z.array(z.string()).default(['nature', 'famous attractions']),
  avoidTolls: z.boolean().default(false),
  /** Paid parking budget assumption per stop, in trip currency. */
  includeParking: z.boolean().default(true),
});
export type PreferencesInput = z.infer<typeof PreferencesInput>;

export const TripRequest = z
  .object({
    title: z.string().max(120).optional(),
    origin: PlaceInput,
    destination: PlaceInput,
    waypoints: z.array(PlaceInput).max(8).default([]),
    startDate: isoDate,
    endDate: isoDate,
    departureTime: hhmm.default('08:00'),
    roundTrip: z.boolean().default(false),
    currency: Currency.default('CAD'),
    vehicle: VehicleInput.default({
      fuelType: 'gasoline',
      consumptionPer100km: 8.5,
      has407Transponder: false,
      tollPasses: [],
    }),
    preferences: PreferencesInput.default({
      pace: 'balanced',
      maxDrivingHoursPerDay: 6,
      interests: ['nature', 'famous attractions'],
      avoidTolls: false,
      includeParking: true,
    }),
  })
  .refine((t) => t.endDate >= t.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] });
export type TripRequest = z.infer<typeof TripRequest>;
export type TripRequestInput = z.input<typeof TripRequest>;

// ---------- Plan output ----------

export const CostCategory = z.enum(['toll', 'etr407', 'fuel', 'charging', 'parking', 'border', 'other']);
export type CostCategory = z.infer<typeof CostCategory>;

/** One line of the cost report with a low / typical / high range. Null = amount unknown. */
export const CostLine = z.object({
  id: z.string(),
  category: CostCategory,
  label: z.string(),
  low: z.number().nullable(),
  typical: z.number().nullable(),
  high: z.number().nullable(),
  currency: Currency,
  confidence: Confidence,
  mandatory: z.boolean().default(true),
  assumptions: z.array(z.string()).default([]),
  source: SourceRef.optional(),
});
export type CostLine = z.infer<typeof CostLine>;

export const CostSummary = z.object({
  low: z.number(),
  typical: z.number(),
  high: z.number(),
  currency: Currency,
  /** Lines whose amount is unknown; never counted as zero. */
  unknownCount: z.number(),
  unknownLabels: z.array(z.string()),
  /** The categories that drive most of the spread between low and high. */
  spreadDrivers: z.array(z.object({ label: z.string(), spread: z.number() })),
});
export type CostSummary = z.infer<typeof CostSummary>;

export const RouteKind = z.enum(['fastest', 'avoid_tolls', 'alternative']);
export type RouteKind = z.infer<typeof RouteKind>;

export const RouteStep = z.object({
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  instruction: z.string().optional(),
  startLocation: LatLng.optional(),
  endLocation: LatLng.optional(),
  /** Encoded polyline of this step, used to place overnight stops mid-step. */
  polyline: z.string().optional(),
  /** Road names mentioned in the instruction, used to detect toll roads like 407 ETR. */
  roads: z.array(z.string()).default([]),
});
export type RouteStep = z.infer<typeof RouteStep>;

export const RouteOption = z.object({
  id: z.string(),
  kind: RouteKind,
  label: z.string(),
  distanceMeters: z.number(),
  durationSeconds: z.number(),
  polyline: z.string().optional(),
  hasTolls: z.boolean(),
  costs: z.array(CostLine),
  summary: CostSummary,
  source: SourceRef,
});
export type RouteOption = z.infer<typeof RouteOption>;

export const OpeningPeriod = z.object({
  /** 0 = Sunday */
  day: z.number().min(0).max(6),
  open: hhmm,
  close: hhmm,
});
export type OpeningPeriod = z.infer<typeof OpeningPeriod>;

export const Stop = z.object({
  id: z.string(),
  name: z.string(),
  /** waypoint = a stop the traveller added in the trip form. */
  kind: z.enum(['attraction', 'meal', 'rest', 'overnight', 'fuel', 'waypoint']),
  location: LatLng,
  placeId: z.string().optional(),
  description: z.string().optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  visitMinutes: z.number().default(60),
  arrivalTime: hhmm.optional(),
  openingHours: z.array(OpeningPeriod).optional(),
  /** 0..1 position along the day's route; used for ordering checks. */
  routeFraction: z.number().min(0).max(1).optional(),
  detourMinutes: z.number().optional(),
  mapsUrl: z.string().optional(),
  source: SourceRef.optional(),
});
export type Stop = z.infer<typeof Stop>;

export const WeatherRating = z.enum(['favourable', 'mixed', 'poor', 'unknown']);
export type WeatherRating = z.infer<typeof WeatherRating>;

export const WeatherAlert = z.object({
  title: z.string(),
  severity: z.enum(['statement', 'advisory', 'watch', 'warning', 'other']),
  area: z.string().optional(),
  issuedBy: z.string(),
  updatedAt: z.string().optional(),
  url: z.string().optional(),
});
export type WeatherAlert = z.infer<typeof WeatherAlert>;

export const WeatherObservation = z.object({
  date: isoDate,
  place: z.string(),
  kind: z.enum(['forecast', 'climate', 'unavailable']),
  summary: z.string().optional(),
  highC: z.number().nullable().optional(),
  lowC: z.number().nullable().optional(),
  precipChancePct: z.number().nullable().optional(),
  snow: z.boolean().optional(),
  thunder: z.boolean().optional(),
  windKmh: z.number().nullable().optional(),
  gustKmh: z.number().nullable().optional(),
  fog: z.boolean().optional(),
  alerts: z.array(WeatherAlert).default([]),
  source: SourceRef.optional(),
});
export type WeatherObservation = z.infer<typeof WeatherObservation>;

export const DayWeatherReview = z.object({
  date: isoDate,
  rating: WeatherRating,
  headline: z.string(),
  observations: z.array(WeatherObservation),
  suggestions: z.array(z.string()),
});
export type DayWeatherReview = z.infer<typeof DayWeatherReview>;

export const Issue = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  message: z.string(),
  day: z.number().optional(),
  stopId: z.string().optional(),
});
export type Issue = z.infer<typeof Issue>;

export const DayPlan = z.object({
  day: z.number(),
  date: isoDate,
  startPlace: z.string(),
  endPlace: z.string(),
  endLocation: LatLng.optional(),
  distanceMeters: z.number(),
  drivingSeconds: z.number(),
  departureTime: hhmm,
  stops: z.array(Stop),
  narrative: z.string().optional(),
  weather: DayWeatherReview.optional(),
});
export type DayPlan = z.infer<typeof DayPlan>;

export const RoadEvent = z.object({
  id: z.string(),
  road: z.string(),
  description: z.string(),
  type: z.string(),
  fullClosure: z.boolean(),
  location: LatLng,
  updatedAt: z.string().optional(),
  source: SourceRef,
});
export type RoadEvent = z.infer<typeof RoadEvent>;

export const TravelAdvisory = z.object({
  countryCode: z.string(),
  country: z.string(),
  level: z.number(),
  text: z.string(),
  updatedAt: z.string(),
  url: z.string(),
  issuedBy: z.string(),
});
export type TravelAdvisory = z.infer<typeof TravelAdvisory>;

export const TripPlan = z.object({
  generatedAt: z.string(),
  request: TripRequest,
  selectedRouteId: z.string(),
  routes: z.array(RouteOption),
  days: z.array(DayPlan),
  issues: z.array(Issue),
  roadEvents: z.array(RoadEvent),
  advisories: z.array(TravelAdvisory),
  /** True when one or more providers ran with sample data (no API key). */
  usedSampleData: z.boolean(),
  providerNotes: z.array(z.string()),
  /** Measured external API spend for this generation, in USD (estimated from list prices). */
  apiCostUsd: z.number(),
});
export type TripPlan = z.infer<typeof TripPlan>;

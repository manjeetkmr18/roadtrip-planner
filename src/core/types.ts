import { z } from 'zod';

/** How much a number can be trusted. Shown next to every cost and fact in the UI. */
export const Confidence = z.enum([
  'verified', // official published rate applied exactly
  'provider_estimate', // a provider's computed estimate (e.g. a flight fare at search time)
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

export const LatLng = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export type LatLng = z.infer<typeof LatLng>;

export const PlaceInput = z.object({
  address: z.string().trim().min(2).max(300),
  location: LatLng.optional(),
  placeId: z.string().max(300).optional(),
});
export type PlaceInput = z.infer<typeof PlaceInput>;

/** A type-ahead suggestion for a place field. Picking one gives the trip a placeId (and a location). */
export interface PlaceSuggestion {
  /** Google place ID; absent for sample suggestions, which carry a location instead. */
  placeId?: string;
  /** Main line, e.g. "Banff". */
  title: string;
  /** Second line, e.g. "AB, Canada". */
  subtitle?: string;
  /** What goes in the field once picked, e.g. "Banff, AB, Canada". */
  address: string;
  location?: LatLng;
}

export const FuelType = z.enum(['gasoline', 'diesel', 'hybrid', 'electric']);
export type FuelType = z.infer<typeof FuelType>;

export const Pace = z.enum(['relaxed', 'balanced', 'packed']);
export type Pace = z.infer<typeof Pace>;

const isoDate = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');
const MAX_TRIP_DAYS = 14;

function withinTripDateLimit(startDate: string, endDate: string) {
  const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  return days <= MAX_TRIP_DAYS;
}

export const VehicleInput = z.object({
  fuelType: FuelType.default('gasoline'),
  /** L/100km for fuel vehicles, kWh/100km for EVs. */
  consumptionPer100km: z.number().positive().max(60).default(8.5),
  /** Legacy (trips saved before tolls were removed); ignored. */
  has407Transponder: z.boolean().optional(),
  /** Legacy (trips saved before tolls were removed); ignored. */
  tollPasses: z.array(z.string()).optional(),
});
export type VehicleInput = z.infer<typeof VehicleInput>;

export const PreferencesInput = z.object({
  pace: Pace.default('balanced'),
  maxDrivingHoursPerDay: z.number().min(1).max(14).default(6),
  interests: z.array(z.string().trim().min(1).max(80)).max(20).default(['nature', 'famous attractions']),
  /** Paid parking budget assumption per stop, in trip currency. */
  includeParking: z.boolean().default(true),
  /** Longest detour (there and back) the planner will suggest for a stop. */
  maxDetourMinutes: z.number().min(0).max(180).default(45),
  avoidFerries: z.boolean().default(false),
  /** Adds sunrise/sunset windows, viewpoints and a filming tip to each day. */
  creatorMode: z.boolean().default(false),
  /** Traveller-specific planning preferences supplied through the trip assistant. */
  personalInstructions: z.string().trim().max(1000).default(''),
});
export type PreferencesInput = z.infer<typeof PreferencesInput>;

// ---------- Getting there (fly + drive) ----------

export const Airport = z.object({
  iata: z.string().length(3),
  name: z.string(),
  city: z.string(),
  country: z.string(),
  location: LatLng,
});
export type Airport = z.infer<typeof Airport>;

/** Local date-time at the airport, no offset: YYYY-MM-DDTHH:MM. */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM')
  .refine((value) => z.iso.date().safeParse(value.slice(0, 10)).success, 'Use a valid local calendar date');

export const FlightSegment = z.object({
  carrier: z.string(),
  carrierCode: z.string().optional(),
  flightNumber: z.string(),
  from: z.string(),
  to: z.string(),
  departLocal: localDateTime,
  arriveLocal: localDateTime,
});
export type FlightSegment = z.infer<typeof FlightSegment>;

/** One flight option for one direction. Not a booking: prices are what the search returned. */
export const FlightOffer = z.object({
  id: z.string(),
  from: Airport,
  to: Airport,
  departLocal: localDateTime,
  arriveLocal: localDateTime,
  durationMinutes: z.number(),
  stops: z.number().int().min(0),
  carrier: z.string(),
  segments: z.array(FlightSegment),
  /** Total for all travellers, in `currency`. Null when the search gave no price. */
  price: z.number().nullable(),
  currency: z.string(),
  travellers: z.number().int().min(1),
  sample: z.boolean(),
  source: SourceRef,
  /** Opens the same search on a flight site, to compare and book there. */
  searchUrl: z.string(),
});
export type FlightOffer = z.infer<typeof FlightOffer>;

export const TravelMode = z.enum(['drive', 'fly_drive']);
export type TravelMode = z.infer<typeof TravelMode>;

export const TravelInput = z.object({
  /** fly_drive: fly to the destination area, then road-trip from the arrival airport in a rental car. */
  mode: TravelMode.default('drive'),
  travellers: z.number().int().min(1).max(9).default(1),
  outbound: FlightOffer.optional(),
  return: FlightOffer.optional(),
  /** Include a rental-car estimate (fly + drive). */
  rentalCar: z.boolean().default(true),
});
export type TravelInput = z.infer<typeof TravelInput>;

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
    }),
    preferences: PreferencesInput.default({
      pace: 'balanced',
      maxDrivingHoursPerDay: 6,
      interests: ['nature', 'famous attractions'],
      includeParking: true,
      maxDetourMinutes: 45,
      avoidFerries: false,
      creatorMode: false,
      personalInstructions: '',
    }),
    travel: TravelInput.default({ mode: 'drive', travellers: 1, rentalCar: true }),
  })
  .refine((t) => t.travel.mode === 'drive' || !!t.travel.outbound, { message: 'Pick an outbound flight for fly + drive', path: ['travel', 'outbound'] })
  .refine((t) => t.endDate >= t.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] })
  .refine((t) => withinTripDateLimit(t.startDate, t.endDate), { message: `Trip cannot exceed ${MAX_TRIP_DAYS} days`, path: ['endDate'] });
export type TripRequest = z.infer<typeof TripRequest>;
export type TripRequestInput = z.input<typeof TripRequest>;

export const TripAdjustmentRequest = z.object({
  arrivalDay: z.number().int().positive(),
  arrivalTime: hhmm,
  resumeTime: hhmm.default('10:00'),
  accommodation: PlaceInput,
});
export type TripAdjustmentRequest = z.infer<typeof TripAdjustmentRequest>;

export const TripAssistantMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(1000),
});

export const TripAssistantRequest = z.object({
  messages: z.array(TripAssistantMessage).min(1).max(12),
  draft: TripRequest.optional(),
}).refine((value) => value.messages.at(-1)?.role === 'user', {
  message: 'The last assistant message must be from the traveller.',
  path: ['messages'],
});

export type TripAssistantRequest = z.infer<typeof TripAssistantRequest>;

export const TripAssistantApplyRequest = z.object({
  request: TripRequest,
  baseGeneratedAt: z.string().min(1).max(50),
});

export type TripAssistantApplyRequest = z.infer<typeof TripAssistantApplyRequest>;

// ---------- Plan output ----------

/** 'toll' and 'etr407' only appear in plans saved before tolls were removed from Travlio. */
export const CostCategory = z.enum(['toll', 'etr407', 'fuel', 'charging', 'parking', 'border', 'flight', 'rental', 'other']);
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

/** 'avoid_tolls' only appears in plans saved before the toll-free option was removed. */
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
  /** Road names mentioned in the instruction. */
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
  /** Legacy (plans saved before tolls were removed). */
  hasTolls: z.boolean().optional(),
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

export const PlacePhoto = z.object({
  url: z.url(),
  attributions: z.array(z.object({
  displayName: z.string(),
  uri: z.url().optional(),
  photoUri: z.url().optional(),
  })).default([]),
});
export type PlacePhoto = z.infer<typeof PlacePhoto>;

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
  arrivalDayOffset: z.number().int().min(0).max(1).optional(),
  openingHours: z.array(OpeningPeriod).optional(),
  /** 0..1 position along the day's route; used for ordering checks. */
  routeFraction: z.number().min(0).max(1).optional(),
  detourMinutes: z.number().optional(),
  mapsUrl: z.string().optional(),
  /** Stable endpoint that resolves current photo URLs and author attribution on demand. */
  photosUrl: z.string().optional(),
  /** Short labels such as the interest the stop matched ("Nature") or "Fuel stop". */
  tags: z.array(z.string()).optional(),
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
  /** A short name for the day, e.g. "Lake Superior shore". */
  title: z.string().optional(),
  /** Local times at the day's end place. */
  sunrise: hhmm.optional(),
  sunset: hhmm.optional(),
  /** Creator mode: a filming / photo tip for the day. */
  creatorTip: z.string().optional(),
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

// ---------- Getting there: drive vs fly + drive ----------

export const TravelOptionsQuery = z.object({
  origin: PlaceInput,
  destination: PlaceInput,
  startDate: isoDate,
  endDate: isoDate,
  roundTrip: z.boolean().default(false),
  travellers: z.number().int().min(1).max(9).default(1),
  maxDrivingHoursPerDay: z.number().min(1).max(14).default(6),
})
  .refine((q) => q.endDate >= q.startDate, { message: 'endDate must be on or after startDate', path: ['endDate'] })
  .refine((q) => withinTripDateLimit(q.startDate, q.endDate), { message: `Trip cannot exceed ${MAX_TRIP_DAYS} days`, path: ['endDate'] });
export type TravelOptionsQuery = z.infer<typeof TravelOptionsQuery>;

export const TravelOptions = z.object({
  origin: z.object({ label: z.string(), location: LatLng }),
  destination: z.object({ label: z.string(), location: LatLng }),
  straightLineKm: z.number(),
  drive: z.object({
    possible: z.boolean(),
    distanceMeters: z.number().optional(),
    durationSeconds: z.number().optional(),
    /** Driving days needed each way at the traveller's max hours per day. */
    daysEachWay: z.number().optional(),
    note: z.string(),
  }),
  recommendation: TravelMode,
  reason: z.string(),
  fromAirports: z.array(Airport),
  toAirports: z.array(Airport),
  outbound: z.array(FlightOffer),
  return: z.array(FlightOffer),
  /** True when flights are sample data (no flight search key). */
  sampleFlights: z.boolean(),
  notes: z.array(z.string()),
});
export type TravelOptions = z.infer<typeof TravelOptions>;

import { FlightsProvider } from './flights.js';
import { PlaceSearchProvider } from './place-search.js';
import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env.js';
import { GeocodingProvider, PlacesProvider, RoutesProvider } from './google.js';
import { WeatherProvider } from './weather.js';
import { AdvisoryProvider, Ontario511Provider } from './open-data.js';
import { FuelPriceProvider } from './costs-data.js';
import { BedrockLlm, type Llm } from './llm.js';

export class Providers {
  constructor(
    readonly geocoding: GeocodingProvider,
    readonly routes: RoutesProvider,
    readonly places: PlacesProvider,
    readonly weather: WeatherProvider,
    readonly roads: Ontario511Provider,
    readonly advisories: AdvisoryProvider,
    readonly fuel: FuelPriceProvider,
    readonly llm: Llm,
    readonly flights: FlightsProvider = new FlightsProvider(),
    readonly placeSearch: PlaceSearchProvider = new PlaceSearchProvider(),
  ) {}

  static fromEnv(env: Env): Providers {
    const live = env.PROVIDER_MODE !== 'sample';
    const k = (v?: string) => (live ? v : undefined);
    return new Providers(
      new GeocodingProvider(k(env.GOOGLE_MAPS_API_KEY)),
      new RoutesProvider(k(env.GOOGLE_MAPS_API_KEY)),
      new PlacesProvider(k(env.GOOGLE_MAPS_API_KEY)),
      new WeatherProvider(env.NWS_USER_AGENT),
      new Ontario511Provider(k(env.ONTARIO_511_API_KEY)),
      new AdvisoryProvider(),
      new FuelPriceProvider(k(env.OILPRICEAPI_KEY), k(env.EIA_API_KEY)),
      new BedrockLlm(k(env.AWS_REGION), k(env.BEDROCK_MODEL_ID), k(env.BEDROCK_FAST_MODEL_ID)),
      new FlightsProvider(k(env.DUFFEL_ACCESS_TOKEN)),
      new PlaceSearchProvider(k(env.GOOGLE_MAPS_API_KEY)),
    );
  }
}

@Global()
@Module({
  providers: [{ provide: Providers, inject: [ENV], useFactory: (env: Env) => Providers.fromEnv(env) }],
  exports: [Providers],
})
export class ProvidersModule {}

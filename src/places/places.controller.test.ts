import { describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.js';
import type { Providers } from '../providers/providers.module.js';
import { PlacesController } from './places.controller.js';

describe('PlacesController photo metadata', () => {
  it('resolves a place image and returns its required attribution without caching the URL', async () => {
    const photo = {
      url: 'https://lh3.googleusercontent.com/short-lived-image',
      attributions: [{ displayName: 'Photographer', uri: 'https://example.com/photographer' }],
    };
    const resolvePhoto = vi.fn(async () => photo);
    const controller = new PlacesController(
      { placeSearch: { live: true }, places: { photo: resolvePhoto } } as unknown as Providers,
      {} as AuthService,
      { assertPro: vi.fn() } as never,
    );

    await expect(controller.photo(
      { placeId: 'ChIJphoto123' },
      { headers: {}, ip: '192.0.2.1' } as never,
    )).resolves.toEqual({ photo });
    expect(resolvePhoto).toHaveBeenCalledWith('ChIJphoto123');
  });

  it('does not attempt Google photo lookup when live Places is not configured', async () => {
    const resolvePhoto = vi.fn();
    const controller = new PlacesController(
      { placeSearch: { live: false }, places: { photo: resolvePhoto } } as unknown as Providers,
      {} as AuthService,
      { assertPro: vi.fn() } as never,
    );

    await expect(controller.photo(
      { placeId: 'ChIJphoto123' },
      { headers: {}, ip: '192.0.2.2' } as never,
    )).rejects.toMatchObject({ status: 400 });
    expect(resolvePhoto).not.toHaveBeenCalled();
  });
});

describe('PlacesController lodging search', () => {
  it('checks Pro access and searches real nearby lodging', async () => {
    const suggestions = [{ placeId: 'ChIJhotel123456', address: '123 Main Street, Calgary, AB' }];
    const search = vi.fn(async () => suggestions);
    const assertPro = vi.fn(async () => undefined);
    const controller = new PlacesController(
      { placeSearch: { live: true, lodging: search } } as unknown as Providers,
      {} as AuthService,
      { assertPro } as never,
    );

    await expect(controller.lodging(
      { id: 'member-1' } as never,
      { q: '', lat: 51.04, lng: -114.06 },
    )).resolves.toEqual({ suggestions });
    expect(assertPro).toHaveBeenCalledWith({ id: 'member-1' });
    expect(search).toHaveBeenCalledWith('', { lat: 51.04, lng: -114.06 });
  });

  it('reports when live hotel suggestions are unavailable', async () => {
    const search = vi.fn();
    const controller = new PlacesController(
      { placeSearch: { live: false, lodging: search } } as unknown as Providers,
      {} as AuthService,
      { assertPro: vi.fn(async () => undefined) } as never,
    );

    await expect(controller.lodging(
      { id: 'member-2' } as never,
      { q: '', lat: 51.04, lng: -114.06 },
    )).rejects.toMatchObject({ status: 503 });
    expect(search).not.toHaveBeenCalled();
  });
});

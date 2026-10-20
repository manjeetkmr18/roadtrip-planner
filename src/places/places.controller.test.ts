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
    );

    await expect(controller.photo(
      { placeId: 'ChIJphoto123' },
      { headers: {}, ip: '192.0.2.2' } as never,
    )).rejects.toMatchObject({ status: 400 });
    expect(resolvePhoto).not.toHaveBeenCalled();
  });
});

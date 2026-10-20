import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../config/env.js';
import { Mailer } from './mailer.js';

describe('Mailer', () => {
  it('never prints verification codes when production delivery is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const mailer = new Mailer({ ...loadEnv({}), NODE_ENV: 'production' });

    await expect(mailer.send({ to: 'user@example.com', subject: 'Verify', text: '123456', html: '123456' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

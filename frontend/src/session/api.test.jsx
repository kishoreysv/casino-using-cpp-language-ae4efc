import { afterEach, describe, expect, it, vi } from 'vitest';

/** Deployment configuration must retain the API namespace for same-origin builds. */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('production API prefix', () => {
  it.each([
    [undefined, '/api/v1/sessions'],
    ['', '/api/v1/sessions'],
    ['/api/', '/api/v1/sessions'],
    ['https://example.invalid/api/', 'https://example.invalid/api/v1/sessions']
  ])('routes a request with configured prefix %s', async (configured, expected) => {
    vi.stubEnv('VITE_API_BASE_URL', configured);
    vi.resetModules();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetch);
    const { request } = await import('./api.js');
    await expect(request('/v1/sessions')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(expected, expect.objectContaining({ method: 'GET' }));
  });
});

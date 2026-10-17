#!/usr/bin/env node
/**
 * End-to-end check of the Travlio API, as a user would use it: sign up, sign in, plan a trip,
 * read the plan, share it, report something, and clean up. Also checks that protected routes are
 * protected, and (with the docs login) runs the live integrations check.
 *
 *   API=https://api.travlio.app/api npm run check:api
 *   API=https://api.travlio.app/api DOCS_USERNAME=... DOCS_PASSWORD=... npm run check:api
 *
 * Creates two throwaway accounts (check-…@example.com) and deletes the trip it plans.
 * Exits with code 1 if anything fails.
 */
const API = (process.env.API ?? 'http://localhost:4000/api').replace(/\/$/, '');
const DOCS = process.env.DOCS_USERNAME && process.env.DOCS_PASSWORD ? `Basic ${Buffer.from(`${process.env.DOCS_USERNAME}:${process.env.DOCS_PASSWORD}`).toString('base64')}` : null;
const color = process.stdout.isTTY ? { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' } : { ok: '', warn: '', fail: '', dim: '', off: '' };

const results = [];
const log = (status, name, detail = '') => {
  results.push({ status, name, detail });
  const mark = { PASS: color.ok, WARN: color.warn, FAIL: color.fail, SKIP: color.dim }[status];
  console.log(`${mark}${status.padEnd(4)}${color.off}  ${name}${detail ? `${color.dim} · ${detail}${color.off}` : ''}`);
};

async function call(method, path, { token, body, auth, expect = [200, 201] } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (auth) headers.authorization = auth;
  const t0 = Date.now();
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  const ms = Date.now() - t0;
  if (!expect.includes(res.status)) {
    const msg = typeof data === 'object' ? (data?.reason ?? data?.message ?? JSON.stringify(data)) : String(data).slice(0, 200);
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${String(msg).slice(0, 240)}`);
  }
  return { status: res.status, data, ms };
}

async function step(name, fn) {
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.warn) log('WARN', name, detail.warn);
    else log('PASS', name, detail ?? '');
    return true;
  } catch (e) {
    log('FAIL', name, e.message);
    return false;
  }
}

const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const email = (tag) => `check-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;

console.log(`Travlio API check → ${API}\n`);
let token, token2, tripId, shareToken, plan;
const password = 'check-password-123';
const userEmail = email('a');

// 1. Up and configured
const up = await step('Health: API up and database connected', async () => {
  const { data, ms } = await call('GET', '/health', { expect: [200, 503] });
  if (data?.error === 'API failed to start') throw new Error(`API failed to start: ${data.reason}`);
  if (!data.ok || !data.db) throw new Error(`ok=${data.ok}, db=${data.db}`);
  const live = Object.entries(data.providers).filter(([, v]) => v).map(([k]) => k);
  return `${ms} ms · queue ${data.queue} · live: ${live.join(', ') || 'none (sample data)'}`;
});
if (!up) {
  console.log('\nThe API is not healthy, so the rest of the checks were skipped.');
  process.exit(1);
}

// 2. Accounts
await step('Auth: register a new account', async () => {
  const { data } = await call('POST', '/auth/register', { body: { email: userEmail, password } });
  if (!data.token) throw new Error('No token returned');
  token = data.token;
  return userEmail;
});
await step('Auth: duplicate email is rejected', async () => {
  await call('POST', '/auth/register', { body: { email: userEmail, password }, expect: [409] });
});
await step('Auth: wrong password is rejected', async () => {
  await call('POST', '/auth/login', { body: { email: userEmail, password: 'not-the-password' }, expect: [401] });
});
await step('Auth: sign in', async () => {
  const { data } = await call('POST', '/auth/login', { body: { email: userEmail, password } });
  token = data.token;
});
await step('Auth: current user', async () => {
  const { data } = await call('GET', '/auth/me', { token });
  if (data.email !== userEmail) throw new Error(`Got ${data.email}`);
  return `plan ${data.plan}`;
});
await step('Security: trips need a sign-in', async () => {
  await call('GET', '/trips', { expect: [401] });
});

// 3. Getting there (drive vs fly)
await step('Getting there: Toronto → Calgary suggests fly + drive with flights', async () => {
  const { data, ms } = await call('POST', '/trips/travel-options', {
    token,
    body: { origin: { address: 'Toronto, ON' }, destination: { address: 'Calgary, AB' }, startDate: day(10), endDate: day(14), roundTrip: true, travellers: 2 },
  });
  if (data.recommendation !== 'fly_drive') throw new Error(`Recommended ${data.recommendation}`);
  if (!data.outbound.length) throw new Error('No outbound flights');
  return `${ms} ms · ${data.outbound.length} flights ${data.fromAirports[0]?.iata} → ${data.toAirports[0]?.iata}${data.sampleFlights ? ' (sample flights)' : ''}`;
});
await step('Getting there: Toronto → Paris has no road', async () => {
  const { data } = await call('POST', '/trips/travel-options', {
    token,
    body: { origin: { address: 'Toronto, ON' }, destination: { address: 'Paris' }, startDate: day(10), endDate: day(14), roundTrip: false },
  });
  if (data.drive.possible) throw new Error('Said Paris is drivable');
});

// 4. A trip, planned end to end
await step('Trips: create a draft (Toronto → Ottawa via Kingston)', async () => {
  const { data } = await call('POST', '/trips', {
    token,
    body: {
      origin: { address: 'Toronto, ON' },
      destination: { address: 'Ottawa, ON' },
      waypoints: [{ address: 'Kingston, ON' }],
      startDate: day(2),
      endDate: day(4),
      roundTrip: true,
      preferences: { interests: ['nature', 'history'] },
    },
  });
  tripId = data.id;
  return tripId;
});
await step('Trips: list includes it', async () => {
  const { data } = await call('GET', '/trips', { token });
  if (!data.some((t) => t.id === tripId)) throw new Error('Not in the list');
});
await step('Trips: rename it', async () => {
  const { data: t } = await call('GET', `/trips/${tripId}`, { token });
  await call('PUT', `/trips/${tripId}`, { token, body: { ...t.request, title: 'API check trip' } });
  const { data } = await call('GET', `/trips/${tripId}`, { token });
  if (data.title !== 'API check trip') throw new Error(`Title is ${data.title}`);
});
await step('Planning: generate the plan', async () => {
  const t0 = Date.now();
  await call('POST', `/trips/${tripId}/generate`, { token, expect: [200, 201, 202] });
  for (;;) {
    const { data } = await call('GET', `/trips/${tripId}`, { token });
    if (data.status === 'ready') {
      plan = data.plan;
      return `${Math.round((Date.now() - t0) / 1000)} s`;
    }
    if (data.status === 'failed') throw new Error(`Planning failed: ${data.error ?? 'no reason given'}`);
    if (Date.now() - t0 > 180_000) throw new Error(`Still "${data.status}" after 3 minutes`);
    await new Promise((r) => setTimeout(r, 2000));
  }
});
if (plan) {
  const route = plan.routes.find((r) => r.id === plan.selectedRouteId) ?? plan.routes[0];
  await step('Plan: days, route and stops', async () => {
    if (!plan.days.length) throw new Error('No days');
    if (!plan.days.some((d) => d.drivingSeconds > 0)) throw new Error('No driving day');
    const stops = plan.days.flatMap((d) => d.stops).filter((s) => s.kind !== 'overnight');
    if (!stops.length) throw new Error('No stops');
    if (!plan.days.some((d) => d.stops.some((s) => s.kind === 'waypoint'))) throw new Error('The added Kingston stop is missing');
    return `${plan.days.length} days · ${(route.distanceMeters / 1000).toFixed(0)} km · ${stops.length} stops`;
  });
  await step('Plan: costs add up, no tolls', async () => {
    const s = route.summary;
    if (!(s.low <= s.typical && s.typical <= s.high)) throw new Error(`Range out of order: ${s.low}/${s.typical}/${s.high}`);
    if (!route.costs.some((c) => c.category === 'fuel' || c.category === 'charging')) throw new Error('No fuel line');
    if (route.costs.some((c) => c.category === 'toll' || c.category === 'etr407')) throw new Error('Toll lines are back');
    return `${s.low}–${s.high} ${s.currency}`;
  });
  await step('Plan: weather for every day', async () => {
    const missing = plan.days.filter((d) => !d.weather?.observations?.length).map((d) => d.day);
    if (missing.length) throw new Error(`No weather on day ${missing.join(', ')}`);
    const kinds = [...new Set(plan.days.flatMap((d) => d.weather.observations.map((o) => o.kind)))];
    const sources = [...new Set(plan.days.flatMap((d) => d.weather.observations.map((o) => o.source?.name).filter(Boolean)))];
    if (!kinds.includes('forecast')) return { warn: `No real forecast in a trip 2 days out (kinds: ${kinds.join(', ')})` };
    return sources.join(' · ');
  });
  await step('Plan: AI wrote the day descriptions', async () => {
    const template = plan.providerNotes.some((n) => /template text/i.test(n));
    const failed = plan.providerNotes.find((n) => /AI arrangement failed/i.test(n));
    if (failed) throw new Error(failed);
    if (template) return { warn: 'Bedrock is not configured, so days use template text' };
    return `e.g. "${plan.days[0].title}"`;
  });
  await step('Plan: live data or sample data', async () => {
    const notes = plan.providerNotes.filter((n) => /sample|not checked|unavailable|failed/i.test(n));
    if (plan.usedSampleData || notes.length) return { warn: notes.join(' | ').slice(0, 300) || 'usedSampleData is true' };
    return 'all live';
  });
}

// 5. Sharing, privacy and feedback
await step('Sharing: create a share link', async () => {
  const { data } = await call('POST', `/trips/${tripId}/share`, { token });
  shareToken = data.shareToken;
  if (!shareToken) throw new Error('No share token');
});
await step('Sharing: the link opens without signing in', async () => {
  const { data } = await call('GET', `/share/${shareToken}`);
  if (!data.plan) throw new Error('No plan in the shared view');
});
await step('Privacy: another user cannot open this trip', async () => {
  const { data } = await call('POST', '/auth/register', { body: { email: email('b'), password } });
  token2 = data.token;
  await call('GET', `/trips/${tripId}`, { token: token2, expect: [403, 404] });
});
await step('Feedback: report incorrect info', async () => {
  const { data } = await call('POST', '/feedback', { token, body: { tripId, itemType: 'other', message: 'Automated API check, please ignore.' } });
  if (!data.received) throw new Error('Not received');
});
await step('Saved stops near Ottawa', async () => {
  const { data } = await call('GET', '/trips/saved-stops/nearby?lat=45.42&lng=-75.69&radiusKm=50', { token });
  return `${Array.isArray(data) ? data.length : 0} saved stop(s)`;
});
await step('Usage counter', async () => {
  const { data } = await call('GET', '/trips/usage', { token });
  if (data.usedThisMonth < 1) throw new Error(`usedThisMonth is ${data.usedThisMonth} after planning a trip`);
  return `${data.usedThisMonth}${data.limit != null ? ` of ${data.limit}` : ''} plans this month`;
});

// 6. Docs and integrations (behind the docs login)
await step('Docs: protected', async () => {
  const { status } = await call('GET', '/docs-json', { expect: [401, 404] });
  return status === 404 ? { warn: 'API docs are off (DOCS_USERNAME / DOCS_PASSWORD not set on the server)' } : 'needs the docs login';
});
if (DOCS) {
  await step('Docs: open with the docs login', async () => {
    const { data } = await call('GET', '/docs-json', { auth: DOCS });
    return `${Object.keys(data.paths ?? {}).length} endpoints documented`;
  });
  const { data: ints } = await call('GET', '/health/integrations', { auth: DOCS, expect: [200, 401, 404] }).catch((e) => ({ data: { error: e.message } }));
  if (ints?.results) {
    console.log(`\nIntegrations (${ints.summary.ok} ok, ${ints.summary.fail} failing, ${ints.summary.off} not configured)`);
    for (const r of ints.results) log(r.status === 'ok' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP', `  ${r.name}`, `${r.detail}${r.status === 'ok' ? ` (${r.ms} ms)` : ''}`);
  } else {
    log('FAIL', 'Integrations check', ints?.error ?? 'Not available (deploy the latest API, and check the docs login)');
  }
} else {
  log('SKIP', 'Docs login and integrations check', 'set DOCS_USERNAME and DOCS_PASSWORD to include them');
}

// 7. Clean up
await step('Clean up: delete the trip', async () => {
  await call('DELETE', `/trips/${tripId}`, { token });
  await call('GET', `/trips/${tripId}`, { token, expect: [404] });
});

const n = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${n('PASS')} passed · ${n('WARN')} warnings · ${n('FAIL')} failed · ${n('SKIP')} skipped`);
process.exit(n('FAIL') ? 1 : 0);

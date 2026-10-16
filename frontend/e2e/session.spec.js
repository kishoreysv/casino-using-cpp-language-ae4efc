/** Exercise session-only journeys over real HTTP; capture text-based visual preflight evidence. */
import { test, expect } from '@playwright/test';

/** Capture accessibility, rendered HTML, typography and screenshots for parent preflight review.
 * Args: page: real browser page; testInfo: attachment metadata; state: evidence label.
 */
async function preflight(page, testInfo, state) {
  await testInfo.attach(`${state}-aria`, { body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain' });
  await testInfo.attach(`${state}-html`, { body: await page.content(), contentType: 'text/html' });
  const styles = await page.evaluate(() => {
    const heading = document.querySelector('h1');
    const body = getComputedStyle(document.body);
    const title = heading ? getComputedStyle(heading) : null;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      bodyFont: body.fontFamily,
      bodyColor: body.color,
      headingFont: title?.fontFamily,
      headingSize: title?.fontSize,
      headingLineHeight: title?.lineHeight
    };
  });
  await testInfo.attach(`${state}-styles`, { body: JSON.stringify(styles, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`), fullPage: true });
}

test('start validates, saves real session data, recovers after reload, and stops idempotently', async ({ page }, testInfo) => {
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /One number/ })).toBeVisible();
  await preflight(page, testInfo, 'welcome');
  await page.getByRole('link', { name: 'Saved session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
  await preflight(page, testInfo, 'empty');
  await page.getByRole('link', { name: 'Start a session', exact: true }).click();
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a name');
  await page.getByLabel('Your name').fill('E2E guest');
  await page.getByLabel('Starting credits').fill('0');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('whole number');
  await preflight(page, testInfo, 'invalid');
  await page.getByLabel('Starting credits').fill('1250');

  // Hold only the outgoing real request; continue it unchanged after inspecting pending UI.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let intercepted;
  const arrived = new Promise((resolve) => { intercepted = resolve; });
  await page.route('**/api/v1/sessions', async (route) => {
    intercepted();
    await gate;
    await route.continue();
  });
  const creationResponse = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await arrived;
  try {
    await expect(page.getByRole('button', { name: 'Saving your seat…' })).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Creating your session securely');
    await preflight(page, testInfo, 'pending');
  } finally {
    release();
  }
  const createdResponse = await creationResponse;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  expect(created.session).toMatchObject({ name: 'E2E guest', balance: 1250, status: 'active', rounds: [] });
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.getByRole('heading', { name: `Welcome, ${created.session.name}.` })).toBeVisible();
  await expect(page.getByLabel('Current balance')).toHaveText(`${created.session.balance.toLocaleString('en-US')} credits`);
  await expect(page.getByText('No rounds yet. Make your first choice at the table.')).toBeVisible();
  await expect(page.getByLabel('Drawn number')).toHaveCount(0);
  await preflight(page, testInfo, 'saved-session');
  const recoveryResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/sessions/current'));
  await page.reload();
  const recovered = await recoveryResponse;
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).session).toEqual(created.session);
  await expect(page.getByRole('heading', { name: `Welcome, ${created.session.name}.` })).toBeVisible();
  await page.getByRole('link', { name: 'Back to rules & setup' }).click();
  await page.getByRole('link', { name: 'View saved session' }).click();
  const stopResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/sessions/stop'));
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  const stopped = await stopResponse;
  expect(stopped.status()).toBe(200);
  const stoppedBody = await stopped.json();
  expect(stoppedBody.session).toEqual({ ...created.session, status: 'stopped' });
  await expect(page.getByRole('status')).toHaveText('stopped');
  const repeat = await page.request.post('/api/v1/sessions/stop', {
    headers: { Authorization: `Bearer ${created.token}` }
  });
  expect(repeat.status()).toBe(200);
  expect(await repeat.json()).toEqual(stoppedBody);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('stopped');
  await expect(page.getByRole('button', { name: 'Stop session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play round', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Current balance')).toHaveText(`${created.session.balance.toLocaleString('en-US')} credits`);
  await expect(page.getByRole('link', { name: 'Start a new session', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('invalid saved capability recovers to an actionable error over real HTTP', async ({ page }, testInfo) => {
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('tenfold.session.token', 'A'.repeat(43)));
  const recovery = page.waitForResponse((response) => response.url().endsWith('/api/v1/sessions/current'));
  await page.goto('/play');
  const response = await recovery;
  expect(response.status()).toBe(401);
  await expect(page.getByRole('alert')).toContainText('session key');
  await expect(page.getByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('tenfold.session.token'))).toBeNull();
  await preflight(page, testInfo, 'recovery-error');
  await page.getByRole('link', { name: 'Start a session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start session', exact: true })).toBeVisible();
  // Chromium reports expected HTTP 401 resources as console errors; allow only that network diagnostic.
  expect(errors.filter((message) => !/^Failed to load resource: the server responded with a status of 401/.test(message))).toEqual([]);
});

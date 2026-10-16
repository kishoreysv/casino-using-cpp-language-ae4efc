/** Exercise round journeys against the live backend; never fabricate draws or HTTP responses. */
import { test, expect } from '@playwright/test';

test.describe.configure({ timeout: 60000 });

/** Capture browser errors before entry so every journey asserts runtime silence.
 * Args: page: browser page under test.
 * Returns: mutable collection of console and uncaught JavaScript errors.
 */
function captureErrors(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Save text-based accessibility, structure and style evidence plus a reviewer screenshot.
 * Args: page: live page; testInfo: project-local output metadata; state: meaningful UI state.
 * Notes: Both desktop and mobile projects execute these captures; no browser run is claimed by authoring them.
 */
async function preflight(page, testInfo, state) {
  await testInfo.attach(`${state}-aria`, {
    body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain'
  });
  await testInfo.attach(`${state}-html`, { body: await page.content(), contentType: 'text/html' });
  const styles = await page.evaluate(() => {
    const sample = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
        color: style.color, background: style.backgroundColor, display: style.display,
        gridTemplateColumns: style.gridTemplateColumns, minHeight: style.minHeight
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      body: sample('body'), heading: sample('h1'), board: sample('.game-board'),
      columns: sample('.game-columns'), numbers: sample('.number-grid'), number: sample('.number-button'),
      reveal: sample('.latest-reveal'), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    };
  });
  await testInfo.attach(`${state}-styles`, {
    body: JSON.stringify(styles, null, 2), contentType: 'application/json'
  });
  await page.screenshot({ path: testInfo.outputPath(`${state}.png`), fullPage: true });
}

/** Assert that the visible reveal, history and balance use the actual committed server result.
 * Args: page: game page; saved: public session returned by the live round API; before: prior balance.
 */
async function assertRound(page, saved, before) {
  const latest = saved.rounds[0];
  expect(Number.isInteger(latest.draw)).toBe(true);
  expect(latest.draw).toBeGreaterThanOrEqual(1);
  expect(latest.draw).toBeLessThanOrEqual(10);
  expect(latest.delta).toBe(latest.draw === latest.guess ? latest.bet * 10 : -latest.bet);
  expect(latest.balance).toBe(before + latest.delta);
  expect(saved.balance).toBe(latest.balance);
  await expect(page.getByLabel('Current balance')).toHaveText(`${saved.balance.toLocaleString('en-US')} credits`);
  await expect(page.getByLabel('Drawn number')).toHaveText(String(latest.draw));
  await expect(page.getByRole('heading', {
    name: latest.delta > 0 ? 'A perfect match.' : 'Not this time.'
  })).toBeVisible();
  await expect(page.locator('.latest-reveal')).toContainText(`You chose ${latest.guess}. The draw was ${latest.draw}.`);
  await expect(page.locator('.latest-reveal')).toContainText(
    `${latest.delta > 0 ? '+' : ''}${latest.delta.toLocaleString('en-US')} credits`
  );
  const items = page.getByRole('region', { name: 'Recent rounds' }).getByRole('listitem');
  await expect(items).toHaveCount(saved.rounds.length);
  for (const [index, round] of saved.rounds.entries()) {
    await expect(items.nth(index)).toContainText(`Draw ${round.draw} / guess ${round.guess}`);
    await expect(items.nth(index)).toContainText(
      `Stake ${round.bet.toLocaleString('en-US')} · Balance ${round.balance.toLocaleString('en-US')}`
    );
  }
}

test('real draws validate, load, reveal, persist, stop and restart through linked routes', async ({ page }, testInfo) => {
  const errors = captureErrors(page);
  const roundRequests = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/rounds')) roundRequests.push(request);
  });
  await page.goto('/');
  await page.getByLabel('Your name').fill('Round guest');
  await page.getByLabel('Starting credits').fill('1250');
  const creation = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const createdResponse = await creation;
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json();
  expect(created.session).toMatchObject({ name: 'Round guest', balance: 1250, status: 'active', rounds: [] });
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(page).toHaveURL(/\/play$/);
  await expect(page.getByRole('heading', { name: 'Welcome, Round guest.' })).toBeVisible();
  await expect(page.getByLabel('Current balance')).toHaveText('1,250 credits');
  await expect(page.getByText('No rounds yet. Make your first choice at the table.')).toBeVisible();
  await expect(page.getByLabel('Drawn number')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Choose your number' }).getByRole('button')).toHaveCount(10);
  await preflight(page, testInfo, 'round-empty');

  await page.getByRole('button', { name: 'Play round', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Choose a number from 1 to 10.');
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '7', exact: true }).click();
  await expect(page.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Stake in credits').fill('99');
  await page.getByRole('button', { name: 'Play round', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('whole-number stake');
  await expect(page.getByLabel('Stake in credits')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Stake in credits')).toBeFocused();
  expect(roundRequests).toHaveLength(0);
  await preflight(page, testInfo, 'round-invalid');
  await page.getByLabel('Stake in credits').fill('100');

  // Delay delivery, not response content: the same request continues to the real API afterward.
  let release;
  let arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const outgoing = new Promise((resolve) => { arrived = resolve; });
  const hold = async (route) => {
    arrived();
    await gate;
    await route.continue();
  };
  await page.route('**/api/v1/rounds', hold);
  const firstDraw = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/rounds') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Play round', exact: true }).click();
  await outgoing;
  try {
    await expect(page.getByRole('button', { name: 'Drawing…' })).toBeDisabled();
    await expect(page.getByLabel('Stake in credits')).toBeDisabled();
    await expect(page.getByRole('button', { name: '7', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toBeDisabled();
    await expect(page.locator('.game-board form')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Committing your round…')).toBeVisible();
    await expect(page.getByLabel('Drawn number')).toHaveCount(0);
    await preflight(page, testInfo, 'round-loading');
  } finally {
    release();
  }
  const firstResponse = await firstDraw;
  expect(firstResponse.status()).toBe(201);
  expect(firstResponse.request().postDataJSON()).toEqual({ bet: 100, guess: 7 });
  expect((await firstResponse.request().allHeaders()).authorization).toBe(`Bearer ${created.token}`);
  const first = (await firstResponse.json()).session;
  expect(first.id).toBe(created.session.id);
  await assertRound(page, first, created.session.balance);
  await page.unroute('**/api/v1/rounds', hold);

  await page.getByRole('button', { name: '1', exact: true }).click();
  await expect(page.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const secondDraw = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/rounds') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Play round', exact: true }).click();
  const secondResponse = await secondDraw;
  expect(secondResponse.status()).toBe(201);
  expect(secondResponse.request().postDataJSON()).toEqual({ bet: 100, guess: 1 });
  const saved = (await secondResponse.json()).session;
  expect(saved.rounds).toHaveLength(2);
  expect(saved.rounds[1]).toEqual(first.rounds[0]);
  expect(saved.rounds[0].id).not.toBe(saved.rounds[1].id);
  await assertRound(page, saved, first.balance);
  expect(roundRequests).toHaveLength(2);
  await preflight(page, testInfo, 'round-result-history');

  const recovery = page.waitForResponse((response) => response.url().endsWith('/api/v1/sessions/current'));
  await page.reload();
  const recovered = await recovery;
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).session).toEqual(saved);
  await assertRound(page, saved, first.balance);
  await page.getByRole('link', { name: 'Back to rules & setup', exact: true }).click();
  await page.getByRole('link', { name: 'View saved session', exact: true }).click();
  await assertRound(page, saved, first.balance);

  const stop = page.waitForResponse((response) => response.url().endsWith('/api/v1/sessions/stop'));
  await page.getByRole('button', { name: 'Stop session', exact: true }).click();
  const stopped = await stop;
  expect(stopped.status()).toBe(200);
  expect((await stopped.json()).session).toEqual({ ...saved, status: 'stopped' });
  await expect(page.getByRole('status')).toHaveText('stopped');
  await expect(page.getByRole('button', { name: 'Play round', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop session', exact: true })).toHaveCount(0);
  await assertRound(page, saved, first.balance);
  await preflight(page, testInfo, 'round-stopped');
  await page.getByRole('link', { name: 'Start a new session', exact: true }).click();
  await page.getByLabel('Your name').fill('Fresh guest');
  const restart = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start a new session', exact: true }).click();
  const restarted = await restart;
  expect(restarted.status()).toBe(201);
  const fresh = await restarted.json();
  expect(fresh.session.id).not.toBe(saved.id);
  expect(fresh.token).not.toBe(created.token);
  expect(fresh.session).toMatchObject({ name: 'Fresh guest', balance: 1000, status: 'active', rounds: [] });
  await expect(page.getByRole('heading', { name: 'Welcome, Fresh guest.' })).toBeVisible();
  await expect(page.getByText('No rounds yet. Make your first choice at the table.')).toBeVisible();
  await expect(page.getByLabel('Drawn number')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play round', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('missing seat and real depleted session offer linked setup and restart without drawing', async ({ page }, testInfo) => {
  const errors = captureErrors(page);
  let draws = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/rounds')) draws++;
  });
  await page.goto('/play');
  await expect(page.getByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
  await page.getByRole('link', { name: 'Start a session', exact: true }).click();
  await page.getByLabel('Your name').fill('Small balance');
  await page.getByLabel('Starting credits').fill('99');
  const creation = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  const response = await creation;
  expect(response.status()).toBe(201);
  const saved = (await response.json()).session;
  expect(saved).toMatchObject({ name: 'Small balance', balance: 99, status: 'depleted', rounds: [] });
  await expect(page.getByLabel('Current balance')).toHaveText('99 credits');
  await expect(page.getByRole('status')).toHaveText('depleted');
  await expect(page.getByText(/below the 100-credit minimum/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play round', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Stake in credits')).toBeDisabled();
  await expect(page.getByRole('button', { name: '1', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Drawn number')).toHaveCount(0);
  await preflight(page, testInfo, 'round-depleted');
  const recovery = page.waitForResponse((result) => result.url().endsWith('/api/v1/sessions/current'));
  await page.reload();
  const recovered = await recovery;
  expect(recovered.status()).toBe(200);
  expect((await recovered.json()).session).toEqual(saved);
  await expect(page.getByRole('status')).toHaveText('depleted');
  await page.getByRole('link', { name: 'Start a new session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start a new session', exact: true })).toBeEnabled();
  await expect(page.getByRole('link', { name: 'View saved session', exact: true })).toBeVisible();
  expect(draws).toBe(0);
  expect(errors).toEqual([]);
});

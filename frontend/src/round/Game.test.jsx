/** Verify real game UI contracts with transport stubs confined to component tests. */
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Game from './Game';
import App from '../App';
import { TOKEN_KEY } from '../session/api';

const token = 'A'.repeat(43);
const session = { id: 'seat', name: 'Ada', balance: 1000, status: 'active', rounds: [] };
const win = { id: 'win', bet: 100, guess: 7, draw: 7, delta: 1000, balance: 2000 };
const loss = { id: 'loss', bet: 100, guess: 1, draw: 7, delta: -100, balance: 900 };

/** Produce the same JSON response envelope as the backend. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Exercise updates through the same root-owned session contract as App. */
function Table({ initial = session }) {
  const [saved, setSaved] = useState(initial);
  return (
    <MemoryRouter initialEntries={['/play']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/play" element={
          <Game session={saved} setSession={setSaved} />
        } />
        <Route path="/" element={
          <h1>Rules and setup</h1>
        } />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem(TOKEN_KEY, token);
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Game', () => {
  it('shows balance and empty history without drawing or pre-revealing a number', () => {
    render(<Table />);
    expect(screen.getByRole('heading', { name: 'Welcome, Ada.' })).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,000 credits');
    expect(screen.getByText(/No rounds yet/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Your next draw awaits.' })).toBeVisible();
    expect(screen.queryByLabelText('Drawn number')).not.toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Choose your number' })).getAllByRole('button')).toHaveLength(10);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('selects native numbers with aria-pressed, posts exact shape and reveals a +10x win', async () => {
    fetch.mockResolvedValue(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201));
    render(<Table />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '1', exact: true }));
    await user.click(screen.getByRole('button', { name: '7', exact: true }));
    expect(screen.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByRole('heading', { name: 'A perfect match.' })).toBeVisible();
    expect(screen.getByLabelText('Drawn number')).toHaveTextContent('7');
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
    expect(screen.getByText('+1,000 credits')).toBeVisible();
    expect(screen.getByText('Draw 7 / guess 7')).toBeVisible();
    expect(screen.getByText('Stake 100 · Balance 2,000')).toBeVisible();
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/rounds');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ bet: 100, guess: 7 });
  });

  it('renders a losing reveal and newest-first real history', async () => {
    fetch.mockResolvedValue(json({ session: { ...session, balance: 1900, rounds: [{ ...loss, balance: 1900 }, win] } }, 201));
    render(<Table initial={{ ...session, balance: 2000, rounds: [win] }} />);
    await userEvent.click(screen.getByRole('button', { name: '1', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByRole('heading', { name: 'Not this time.' })).toBeVisible();
    expect(screen.getByText('You chose 1. The draw was 7.')).toBeVisible();
    expect(screen.getByText('-100 credits')).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,900 credits');
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Draw 7 / guess 1');
    expect(items[1]).toHaveTextContent('Draw 7 / guess 7');
  });

  it.each(['', '0', '-1', '99', '100.5', '1001'])('rejects stake %s independently and focuses its accessible error', async (value) => {
    render(<Table />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '7', exact: true }));
    await user.clear(screen.getByLabelText('Stake in credits'));
    if (value) await user.type(screen.getByLabelText('Stake in credits'), value);
    await user.click(screen.getByRole('button', { name: 'Play round' }));
    expect(screen.getByRole('alert')).toHaveTextContent('whole-number stake');
    expect(screen.getByLabelText('Stake in credits')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Stake in credits')).toHaveAttribute('aria-describedby', 'stake-hint bet-error');
    expect(screen.getByLabelText('Stake in credits')).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects missing guess independently and focuses the first number', async () => {
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a number');
    expect(screen.getByRole('group', { name: 'Choose your number' })).toHaveAttribute('aria-describedby', 'guess-error');
    expect(screen.getByRole('button', { name: '1', exact: true })).toHaveFocus();
    expect(screen.getByLabelText('Stake in credits')).toHaveAttribute('aria-invalid', 'false');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects potential win overflow even with a stake within balance', async () => {
    render(<Table initial={{ ...session, balance: 999999999 }} />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(screen.getByRole('alert')).toHaveTextContent('potential win');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('locks play, stake, number board and stop while pending; duplicate clicks create only one command', async () => {
    let release;
    fetch.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render(<Table />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '7', exact: true }));
    await user.dblClick(screen.getByRole('button', { name: 'Play round' }));
    expect(screen.getByRole('button', { name: 'Drawing…' })).toBeDisabled();
    expect(screen.getByLabelText('Stake in credits')).toBeDisabled();
    expect(screen.getByRole('button', { name: '1', exact: true })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeDisabled();
    expect(screen.getByText('Committing your round…')).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201));
    expect(await screen.findByRole('heading', { name: 'A perfect match.' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
  });

  it('ignores obsolete responses when an isolated Game receives a replacement session', async () => {
    let release;
    fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const setSession = vi.fn();
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Game session={session} setSession={setSession} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(screen.getByRole('button', { name: 'Drawing…' })).toBeDisabled();
    const replacement = { ...session, id: 'replacement', name: 'Grace', balance: 3000 };
    sessionStorage.setItem(TOKEN_KEY, 'B'.repeat(43));
    view.rerender(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Game session={replacement} setSession={setSession} />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
    await act(async () => { release(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201)); });
    expect(setSession).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Welcome, Grace.' })).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('3,000 credits');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
  });

  it('does not update its session owner after an isolated pending Game is unmounted', async () => {
    let reject;
    fetch.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const setSession = vi.fn();
    const view = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Game session={session} setSession={setSession} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    view.unmount();
    await act(async () => { reject(new TypeError('late offline failure')); });
    expect(setSession).not.toHaveBeenCalled();
    expect(view.container).toBeEmptyDOMElement();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
  });

  it('preserves valid input after server field rejection and permits deliberate retry', async () => {
    fetch.mockResolvedValueOnce(json({ error: 'Stake rejected.', fields: { bet: 'Choose a smaller stake.' } }, 400));
    fetch.mockResolvedValueOnce(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByText('Stake rejected.')).toBeVisible();
    expect(screen.getByText('Choose a smaller stake.')).toBeVisible();
    expect(screen.getByLabelText('Stake in credits')).toHaveValue(100);
    expect(screen.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,000 credits');
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByRole('heading', { name: 'A perfect match.' })).toBeVisible();
  });

  it.each([0, 500, 409])('requires refresh rather than blind replay after uncertain status %s', async (status) => {
    if (!status) fetch.mockRejectedValueOnce(new TypeError('offline'));
    else fetch.mockResolvedValueOnce(json({ error: 'Check saved state.' }, status));
    fetch.mockResolvedValueOnce(json({ session: { ...session, balance: 2000, rounds: [win] } }));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByRole('button', { name: 'Refresh saved state' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved state' }));
    expect(await screen.findByRole('heading', { name: 'A perfect match.' })).toBeVisible();
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/sessions/current');
    expect(fetch.mock.calls[1][1].method).toBe('GET');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
  });

  it('retains refresh error and permits refreshing again without replay', async () => {
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockResolvedValueOnce(json({ error: 'Still unavailable.' }, 500));
    fetch.mockResolvedValueOnce(json({ session }));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh saved state' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Still unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved state' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/No rounds yet/)).toBeVisible();
  });

  it('clears invalid capability/root state after a play 401 and links to setup', async () => {
    fetch.mockResolvedValue(json({ error: 'Session key invalid.' }, 401));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Session key invalid');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'Start a session' }));
    expect(screen.getByRole('heading', { name: 'Rules and setup' })).toBeVisible();
  });

  it('stops through real transport with pending state and shows finished/restart actions', async () => {
    let release;
    fetch.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render(<Table initial={{ ...session, balance: 2000, rounds: [win] }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(screen.getByText('Saving the stopped session…')).toBeVisible();
    release(json({ session: { ...session, balance: 2000, status: 'stopped', rounds: [win] } }));
    expect(await screen.findByText('stopped')).toBeVisible();
    expect(screen.getByText(/Your session is finished/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Stop session' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/sessions/stop');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    await userEvent.click(screen.getByRole('link', { name: 'Start a new session' }));
    expect(screen.getByRole('heading', { name: 'Rules and setup' })).toBeVisible();
  });

  it('preserves stopped-command failure and permits stop retry', async () => {
    fetch.mockResolvedValueOnce(json({ error: 'Please try again.' }, 500));
    fetch.mockResolvedValueOnce(json({ session: { ...session, status: 'stopped' } }));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again');
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,000 credits');
    await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByText('stopped')).toBeVisible();
  });

  it.each([99, 0])('disables play at depleted balance %s while keeping history and restart', (balance) => {
    render(<Table initial={{ ...session, balance, status: 'depleted', rounds: [loss] }} />);
    expect(screen.getByText(/below the 100-credit minimum/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '7', exact: true })).toBeDisabled();
    expect(screen.getByLabelText('Stake in credits')).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Start a new session' })).toBeVisible();
    expect(screen.getByText('Draw 7 / guess 1')).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('transitions to depleted from a real returned loss rather than client arithmetic', async () => {
    fetch.mockResolvedValue(json({ session: { ...session, balance: 0, status: 'depleted', rounds: [loss] } }, 201));
    render(<Table initial={{ ...session, balance: 100 }} />);
    await userEvent.click(screen.getByRole('button', { name: '1', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    expect(await screen.findByText('depleted')).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('0 credits');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
  });

  it('selects a number by keyboard and submits without a pointer', async () => {
    fetch.mockResolvedValue(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201));
    render(<Table />);
    const user = userEvent.setup();
    screen.getByRole('button', { name: '7', exact: true }).focus();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: '7', exact: true })).toHaveAttribute('aria-pressed', 'true');
    screen.getByRole('button', { name: 'Play round' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'A perfect match.' })).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
  });

  it('blocks programmatic submission on finished sessions as well as disabling controls', () => {
    render(<Table initial={{ ...session, status: 'stopped' }} />);
    fireEvent.submit(screen.getByLabelText('Stake in credits').closest('form'));
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,000 credits');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks uncertain submission, exposes refresh pending, and accepts the recovered finished state', async () => {
    let release;
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    render(<Table />);
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh saved state' });
    fireEvent.submit(screen.getByLabelText('Stake in credits').closest('form'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await userEvent.click(refresh);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByLabelText('Stake in credits').closest('form')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Refreshing saved state…')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop session' })).toBeDisabled();
    release(json({ session: { ...session, status: 'stopped', balance: 2000, rounds: [win] } }));
    expect(await screen.findByText('stopped')).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
    expect(screen.getByText('Draw 7 / guess 7')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Refresh saved state' })).not.toBeInTheDocument();
  });

  it.each(['stop', 'refresh'])('clears root state on authenticated %s failure', async (action) => {
    if (action === 'refresh') fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockResolvedValueOnce(json({ error: 'Session key invalid.' }, 401));
    render(<Table />);
    if (action === 'refresh') {
      await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
      await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Refresh saved state' }));
    } else {
      await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    }
    expect(await screen.findByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('Session key invalid');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole('link', { name: 'Start a session' })).toHaveAttribute('href', '/');
  });

  it('has an actionable no-session state and safely renders HTML-like names', () => {
    const first = render(<Table initial={null} />);
    expect(screen.getByRole('link', { name: 'Start a session' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Play round' })).not.toBeInTheDocument();
    first.unmount();
    const { container } = render(<Table initial={{ ...session, name: '<script>alert(1)</script>' }} />);
    expect(screen.getByRole('heading', { name: 'Welcome, <script>alert(1)</script>.' })).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
  });

  it.each(['Back to rules & setup', 'Rules & setup', 'Tenfold home'])
    ('keeps a pending play locked after leaving via %s and returning', async (link) => {
      let release;
      fetch.mockResolvedValueOnce(json({ session }));
      fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
      window.history.replaceState({}, '', '/play');
      render(<App />);
      await userEvent.click(await screen.findByRole('button', { name: '7', exact: true }));
      await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
      await userEvent.click(screen.getByRole('link', { name: link }));
      await userEvent.click(screen.getByRole('link', { name: 'Saved session', exact: true }));
      expect(screen.getByRole('button', { name: 'Drawing…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Stop session' })).toBeDisabled();
      fireEvent.submit(screen.getByLabelText('Stake in credits').closest('form'));
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => { release(json({ session: { ...session, balance: 2000, rounds: [win] } }, 201)); });
      expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
      expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
    });

  it('retains uncertainty across navigation and failed refresh until successful recovery', async () => {
    let recover;
    fetch.mockResolvedValueOnce(json({ session }));
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockResolvedValueOnce(json({ error: 'Still unavailable.' }, 500));
    fetch.mockReturnValueOnce(new Promise((resolve) => { recover = resolve; }));
    window.history.replaceState({}, '', '/play');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    await screen.findByRole('button', { name: 'Refresh saved state' });
    await userEvent.click(screen.getByRole('link', { name: 'Rules & setup' }));
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Stake in credits').closest('form'));
    expect(fetch).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved state' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Still unavailable');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh saved state' }));
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    await act(async () => { recover(json({ session: { ...session, balance: 2000, rounds: [win] } })); });
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('2,000 credits');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
    expect(fetch.mock.calls.slice(2).map(([url]) => url)).toEqual([
      '/api/v1/sessions/current', '/api/v1/sessions/current'
    ]);
  });

  it.each(['success', 'unauthorized'])('ignores an old play %s after starting a new session', async (outcome) => {
    let oldPlay;
    let newPlay;
    const newToken = 'B'.repeat(43);
    const newSession = { ...session, id: 'new-seat', name: 'Grace', balance: 3000 };
    fetch.mockResolvedValueOnce(json({ session }));
    fetch.mockReturnValueOnce(new Promise((resolve) => { oldPlay = resolve; }));
    fetch.mockResolvedValueOnce(json({ token: newToken, session: newSession }, 201));
    fetch.mockReturnValueOnce(new Promise((resolve) => { newPlay = resolve; }));
    window.history.replaceState({}, '', '/play');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    await userEvent.click(screen.getByRole('link', { name: 'Back to rules & setup' }));
    await userEvent.type(screen.getByLabelText('Your name'), 'Grace');
    await userEvent.click(screen.getByRole('button', { name: 'Start a new session' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Grace.' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '7', exact: true }));
    await userEvent.click(screen.getByRole('button', { name: 'Play round' }));
    await act(async () => {
      oldPlay(outcome === 'success'
        ? json({ session: { ...session, balance: 2000, rounds: [win] } }, 201)
        : json({ error: 'Old key expired.' }, 401));
    });
    expect(screen.getByRole('heading', { name: 'Welcome, Grace.' })).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('3,000 credits');
    expect(screen.getByRole('button', { name: 'Drawing…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(newToken);
    expect(fetch).toHaveBeenCalledTimes(4);
    await act(async () => { newPlay(json({ session: { ...newSession, balance: 4000, rounds: [win] } }, 201)); });
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('4,000 credits');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeEnabled();
  });

  it('preserves finished saved data and history through app recovery and link navigation', async () => {
    const saved = { ...session, balance: 2000, status: 'stopped', rounds: [win] };
    fetch.mockResolvedValue(json({ session: saved }));
    render(<App />);
    await userEvent.click(await screen.findByRole('link', { name: 'View saved session' }));
    expect(screen.getByText('Draw 7 / guess 7')).toBeVisible();
    expect(screen.getByText('stopped')).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Back to rules & setup' }));
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByText('Draw 7 / guess 7')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

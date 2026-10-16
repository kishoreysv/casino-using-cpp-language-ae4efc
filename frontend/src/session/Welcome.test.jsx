/** Verify the welcome workflow, shared transport and app recovery using component-level HTTP stubs. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Welcome from './Welcome';
import App from '../App';
import { ApiError, recoverSession, request, startSession, stopSession, TOKEN_KEY } from './api';

const session = { id: 'session-id', name: 'Ada', balance: 1000, status: 'active', rounds: [] };
const token = 'A'.repeat(43);

/** Return the same JSON envelope used by the real HTTP API. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Render the welcome route and its navigable summary destination. */
function renderWelcome(savedSession = null, setSession = vi.fn()) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route
          path="/"
          element={
            <Welcome session={savedSession} setSession={setSession} />
          }
        />
        <Route path="/play" element={
          <main>
            <h1>Saved session destination</h1>
          </main>
        } />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Welcome', () => {
  it('shows the exact fictional-credit rules and starts a session with persisted capability', async () => {
    fetch.mockResolvedValue(json({ token, session }, 201));
    const setSession = vi.fn();
    renderWelcome(null, setSession);
    expect(screen.getByText(/stake is not deducted first/i)).toBeVisible();
    expect(screen.getByText(/no money, payments, or prizes/i)).toBeVisible();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), '  Ada  ');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByRole('heading', { name: 'Saved session destination' })).toBeVisible();
    expect(setSession).toHaveBeenCalledWith(session);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: 'Ada', deposit: 1000 });
  });

  it('rejects empty name independently without making a request', async () => {
    renderWelcome();
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name');
    expect(screen.getByLabelText('Your name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Starting credits')).toHaveAttribute('aria-invalid', 'false');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', '0', '-1', '1.5', '1000001'])('rejects deposit %s independently and associates its error', async (deposit) => {
    renderWelcome();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Ada');
    await user.clear(screen.getByLabelText('Starting credits'));
    if (deposit) await user.type(screen.getByLabelText('Starting credits'), deposit);
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(screen.getByRole('alert')).toHaveTextContent('whole number');
    expect(screen.getByLabelText('Starting credits')).toHaveAttribute('aria-describedby', 'credits-hint deposit-error');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables inputs and duplicate submission while the request is pending', async () => {
    let resolve;
    fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderWelcome();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(screen.getByRole('button', { name: 'Saving your seat…' })).toBeDisabled();
    expect(screen.getByLabelText('Your name')).toBeDisabled();
    expect(screen.getByLabelText('Starting credits')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Creating your session securely');
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(json({ token, session }, 201));
    expect(await screen.findByRole('heading', { name: 'Saved session destination' })).toBeVisible();
  });

  it('shows backend field errors, preserves inputs and allows successful retry', async () => {
    fetch.mockResolvedValueOnce(json({ error: 'Check starting credits.', fields: { deposit: 'Too many credits.' } }, 400));
    fetch.mockResolvedValueOnce(json({ token, session }, 201));
    renderWelcome();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Your name'), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByText('Check starting credits.')).toBeVisible();
    expect(screen.getByText('Too many credits.')).toBeVisible();
    expect(screen.getByLabelText('Your name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Starting credits')).toHaveValue(1000);
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByRole('heading', { name: 'Saved session destination' })).toBeVisible();
  });

  it('shows a network failure without losing form values or writing a token', async () => {
    fetch.mockRejectedValue(new TypeError('offline'));
    renderWelcome();
    await userEvent.type(screen.getByLabelText('Your name'), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByLabelText('Your name')).toHaveValue('Ada');
  });

  it('links to an existing session and renders security-like names as text', async () => {
    const literal = '<script>alert(1)</script>';
    const { container } = renderWelcome({ ...session, name: literal });
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByRole('heading', { name: 'Saved session destination' })).toBeVisible();
  });
});

describe('shared API transport', () => {
  it('exports a reusable request with explicit Bearer authorization and no default token leakage', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockImplementation(() => Promise.resolve(json({ session })));
    expect(await request('/v1/sessions/current', { token })).toEqual({ session });
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/sessions/current');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);
    await request('/health');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });

  it('clears persisted capability on authenticated 401, not an unrelated public error', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockImplementation(() => Promise.resolve(json({ error: 'Invalid key.' }, 401)));
    await expect(request('/health')).rejects.toBeInstanceOf(ApiError);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
    await expect(recoverSession()).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('retains the capability on transient failure and exposes a safe error', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockRejectedValue(new Error('network failure details'));
    await expect(recoverSession()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('connection') });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
  });

  it('handles non-JSON failures without exposing raw response content', async () => {
    fetch.mockResolvedValue(new Response('<html>upstream failed</html>', { status: 502 }));
    await expect(request('/health')).rejects.toMatchObject({ message: expect.stringContaining('connection') });
  });

  it('clears an authenticated key even when a 401 response is not JSON', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    await expect(recoverSession()).rejects.toBeInstanceOf(ApiError);
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('forwards caller cancellation without changing the persisted capability', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = recoverSession(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
  });

  it('starts, recovers and stops via the shared envelopes', async () => {
    fetch.mockResolvedValueOnce(json({ token, session }, 201));
    fetch.mockResolvedValueOnce(json({ session }));
    fetch.mockResolvedValueOnce(json({ session: { ...session, status: 'stopped' } }));
    expect(await startSession({ name: 'Ada', deposit: 1000 })).toEqual(session);
    expect(await recoverSession()).toEqual(session);
    expect(await stopSession()).toEqual({ ...session, status: 'stopped' });
    expect(fetch.mock.calls[2][0]).toBe('/api/v1/sessions/stop');
    expect(fetch.mock.calls[2][1].method).toBe('POST');
  });
});

describe('app-owned recovery and navigation', () => {
  it('shows a no-session summary through a visible navigation link', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: /One number/ });
    await userEvent.click(screen.getByRole('link', { name: 'Saved session' }));
    expect(screen.getByRole('heading', { name: 'Your table starts here.' })).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('link', { name: 'Start a session' }));
    expect(screen.getByRole('heading', { name: /One number/ })).toBeVisible();
  });

  it('recovers persisted data, stops it, and keeps that state across routes', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockResolvedValueOnce(json({ session }));
    fetch.mockResolvedValueOnce(json({ session: { ...session, status: 'stopped' } }));
    render(<App />);
    await screen.findByRole('link', { name: 'View saved session' });
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByRole('heading', { name: 'Welcome, Ada.' })).toBeVisible();
    expect(screen.getByText('1,000 credits')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByText('stopped')).toBeVisible();
    await userEvent.click(screen.getByRole('link', { name: 'Back to rules & setup' }));
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByText('stopped')).toBeVisible();
    expect(screen.getByLabelText('Current balance')).toHaveTextContent('1,000 credits');
    expect(screen.getByRole('button', { name: 'Play round' })).toBeDisabled();
    expect(screen.getByText(/No rounds yet/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Start a new session' })).toHaveAttribute('href', '/');
  });

  it('shows recovery loading while a request remains pending', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    let resolve;
    fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Recovering your session');
    resolve(json({ session }));
    expect(await screen.findByRole('link', { name: 'View saved session' })).toBeVisible();
  });

  it('shows transient recovery failure and retries with the same persisted key', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockRejectedValueOnce(new TypeError('offline'));
    fetch.mockResolvedValueOnce(json({ session }));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await userEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
    expect(await screen.findByRole('link', { name: 'View saved session' })).toBeVisible();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe(token);
  });

  it('clears an invalid saved key and offers the actual start workflow', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockResolvedValue(json({ error: 'Session key invalid.' }, 401));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Session key invalid');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  });

  it('renders the depleted state and server stop failure without changing the balance', async () => {
    sessionStorage.setItem(TOKEN_KEY, token);
    fetch.mockResolvedValueOnce(json({ session: { ...session, balance: 99, status: 'depleted' } }));
    fetch.mockResolvedValueOnce(json({ error: 'Please try again.' }, 500));
    render(<App />);
    await screen.findByRole('link', { name: 'View saved session' });
    await userEvent.click(screen.getByRole('link', { name: 'View saved session' }));
    expect(screen.getByText(/below the 100-credit minimum/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Stop session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please try again.');
    expect(screen.getByText('99 credits')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop session' })).toBeEnabled());
  });
});

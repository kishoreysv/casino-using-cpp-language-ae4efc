/** Own the single browser router and recoverable session state for all feature routes. */
import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import Welcome from './session/Welcome';
import { recoverSession, stopSession, TOKEN_KEY } from './session/api';

/** Display real saved session state until the separate game-table slice is installed.
 * Args: session: recovered public state; setSession: root state updater.
 * Returns: session summary and an idempotent stop action, not a simulated game.
 */
function SessionSummary({ session, setSession }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  /** Stop through the real API and update the root session state. */
  async function stop() {
    setPending(true);
    setError('');
    try {
      setSession(await stopSession());
    } catch (failure) {
      if (failure.status === 401) setSession(null);
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }

  if (!session) {
    return (
      <section className="summary-card" aria-labelledby="empty-title">
        <p className="eyebrow">NO SAVED SEAT</p>
        <h1 id="empty-title">Your table starts here.</h1>
        <p>Start a session to save your name and fictional credits in this tab.</p>
        {error && (
          <p className="alert" role="alert">{error}</p>
        )}
        <Link className="button primary" to="/">Start a session</Link>
      </section>
    );
  }
  return (
    <section className="summary-card" aria-labelledby="summary-title">
      <p className="eyebrow">YOUR SAVED SESSION</p>
      <h1 id="summary-title">Welcome, {session.name}.</h1>
      <dl className="session-facts">
        <div>
          <dt>Balance</dt>
          <dd>{session.balance.toLocaleString()} credits</dd>
        </div>
        <div>
          <dt>Session status</dt>
          <dd className="status-badge" role="status">{session.status}</dd>
        </div>
        <div>
          <dt>Recent rounds</dt>
          <dd>{session.rounds.length}</dd>
        </div>
      </dl>
      <p>Your session is saved. The number grid, draw reveal, and game table are coming in the next feature slice.</p>
      {session.status === 'depleted' && (
        <p className="notice">This balance is below the 100-credit minimum. Start a new session to play.</p>
      )}
      {error && (
        <p className="alert" role="alert">{error}</p>
      )}
      <div className="summary-actions">
        <Link className="button secondary" to="/">Back to rules &amp; setup</Link>
        {session.status !== 'stopped' && (
          <button className="button secondary" disabled={pending} onClick={stop}>
            {pending ? 'Stopping…' : 'Stop session'}
          </button>
        )}
      </div>
      <p className="input-hint" aria-live="polite">{pending ? 'Saving the stopped session…' : 'Fictional credits only.'}</p>
    </section>
  );
}
SessionSummary.propTypes = {
  session: PropTypes.shape({
    name: PropTypes.string.isRequired,
    balance: PropTypes.number.isRequired,
    status: PropTypes.string.isRequired,
    rounds: PropTypes.array.isRequired
  }),
  setSession: PropTypes.func.isRequired
};

/** Render the shared shell and recovery boundary; session state survives route changes. */
function SessionApp() {
  const [session, setSession] = useState(null);
  const [recovering, setRecovering] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    /** Recover persisted state, preserving the key on transient network failures. */
    async function recover() {
      setRecovering(true);
      setError('');
      try {
        if (sessionStorage.getItem(TOKEN_KEY)) setSession(await recoverSession(controller.signal));
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setRecovering(false);
      }
    }
    recover();
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label="Tenfold home">
          tenfold
          <span aria-hidden="true">.</span>
        </Link>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>Rules &amp; setup</NavLink>
          <NavLink to="/play">Saved session</NavLink>
        </nav>
        <span className="header-note">NO REAL MONEY. JUST INSTINCT.</span>
      </header>
      <main id="main-content" tabIndex="-1">
        {recovering ? (
          <section className="summary-card" role="status" aria-live="polite">
            <p className="eyebrow">FINDING YOUR SEAT</p>
            <h1>Recovering your session…</h1>
          </section>
        ) : (
          <>
            {error && (
              <div className="recovery-error">
                <p className="alert" role="alert">{error}</p>
                <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Retry recovery</button>
              </div>
            )}
            <Routes>
              <Route
                path="/"
                element={
                  <Welcome session={session} setSession={setSession} />
                }
              />
              <Route
                path="/play"
                element={
                  <SessionSummary session={session} setSession={setSession} />
                }
              />
              <Route path="*" element={
                <section className="summary-card">
                  <h1>That seat doesn’t exist.</h1>
                  <Link to="/">Back to rules &amp; setup</Link>
                </section>
              } />
            </Routes>
          </>
        )}
      </main>
      <footer className="site-footer">
        <p>Tenfold / The classic guessing game, reimagined.</p>
        <p>One tab. One session. Ten possibilities.</p>
      </footer>
    </div>
  );
}

/** Install exactly one router; main.jsx remains a rendering entry only. */
export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SessionApp />
    </BrowserRouter>
  );
}

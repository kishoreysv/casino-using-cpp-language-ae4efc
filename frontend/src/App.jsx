/** Own the single browser router and recoverable session state for all feature routes. */
import { useEffect, useState } from 'react';
import Game from './round/Game';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import Welcome from './session/Welcome';
import { recoverSession, TOKEN_KEY } from './session/api';
import useSessionCommands from './session/useSessionCommands';

/** Render the shared shell and recovery boundary; session state survives route changes. */
function SessionApp() {
  const [session, setSession] = useState(null);
  const commands = useSessionCommands(session, setSession);
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
        if (sessionStorage.getItem(TOKEN_KEY)) {
          const saved = await recoverSession(controller.signal);
          if (!controller.signal.aborted) setSession(saved);
        }
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
                  <Game key={session?.id} session={session} setSession={setSession} commands={commands} />
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

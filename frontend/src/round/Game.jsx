/** Render the real game table; draw and history always come from the authenticated API. */
import { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import useSessionCommands from '../session/useSessionCommands';

const numbers = Array.from({ length: 10 }, (_, index) => index + 1);

/** Present stake, selection, committed results and recoverable command failures.
 * Args: session: public root-owned session or null; setSession: React session updater;
 *   commands: optional root-owned command hook result, retained across route changes.
 * Returns: Accessible table or actionable no-session state, without advance draw information.
 * Notes: An uncertain play is never automatically replayed; refresh saved state before choosing to play again.
 */
export default function Game({ session, setSession, commands }) {
  const [bet, setBet] = useState('100');
  const [guess, setGuess] = useState(null);
  const localCommands = useSessionCommands(session, setSession);
  const { pending, uncertain, fields, error, setFields, setError, run } = commands ?? localCommands;
  const stakeRef = useRef(null);
  const firstNumberRef = useRef(null);
  const active = session?.status === 'active' && session.balance >= 100;
  const latest = session?.rounds[0];

  /** Run one command, preserving values on failure and clearing expired root state.
   * Args: action: play, stop or refresh saved state.
   * Notes: Refresh is required after an uncertain play to avoid blindly duplicating a committed round.
   */
  async function command(action) {
    if (pending || (action === 'play' && (!active || uncertain))) return;
    if (action === 'play') {
      const next = {};
      const value = Number(bet);
      if (!bet.trim() || !Number.isInteger(value) || value < 100 || value > session.balance) {
        next.bet = 'Enter a whole-number stake from 100 up to your balance.';
      } else if (session.balance + value * 10 > 1000000000) {
        next.bet = 'Choose a smaller stake: a potential win exceeds the balance limit.';
      }
      if (!Number.isInteger(guess) || guess < 1 || guess > 10) next.guess = 'Choose a number from 1 to 10.';
      setFields(next);
      setError('');
      if (Object.keys(next).length) {
        (next.bet ? stakeRef : firstNumberRef).current?.focus();
        return;
      }
    }
    await run(action, { bet: Number(bet), guess });
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
    <section className="game-layout" aria-labelledby="game-title">
      <header className="game-heading">
        <div>
          <p className="eyebrow">TEN POSSIBILITIES / ONE CHOICE</p>
          <h1 id="game-title">Welcome, {session.name}.</h1>
        </div>
        <dl className="game-balance">
          <div>
            <dt>Balance</dt>
            <dd aria-label="Current balance">{session.balance.toLocaleString()} credits</dd>
          </div>
          <div>
            <dt>Session status</dt>
            <dd className="status-badge" role="status">{session.status}</dd>
          </div>
        </dl>
      </header>
      <div className="game-columns">
        <div className="game-board">
          <p className="eyebrow">THE TABLE</p>
          <h2>Trust your number.</h2>
          <p className="board-rules">A match adds your stake × 10. A miss costs your stake. Nothing is deducted before a win.</p>
          {!active && (
            <p className="notice">
              {session.status === 'stopped'
                ? 'Your session is finished. Your rounds are saved below.'
                : 'This balance is below the 100-credit minimum. Start a new session to play.'}
            </p>
          )}
          <form
            noValidate
            aria-busy={Boolean(pending)}
            onSubmit={(event) => { event.preventDefault(); command('play'); }}
          >
            <div className="field">
              <label htmlFor="stake">Stake in credits</label>
              <input
                ref={stakeRef}
                id="stake"
                type="number"
                inputMode="numeric"
                min="100"
                max={session.balance}
                step="1"
                value={bet}
                onChange={(event) => setBet(event.target.value)}
                disabled={!active || Boolean(pending) || uncertain}
                aria-required="true"
                aria-invalid={Boolean(fields.bet)}
                aria-describedby={`stake-hint${fields.bet ? ' bet-error' : ''}`}
              />
              <p id="stake-hint" className="input-hint">Minimum 100. Maximum your balance; potential wins must fit the balance limit.</p>
              {fields.bet && (
                <p id="bet-error" className="field-error" role="alert">{fields.bet}</p>
              )}
            </div>
            <fieldset
              className="number-picker"
              disabled={!active || Boolean(pending) || uncertain}
              aria-invalid={Boolean(fields.guess)}
              aria-describedby={fields.guess ? 'guess-error' : 'guess-hint'}
            >
              <legend>Choose your number</legend>
              <p id="guess-hint" className="input-hint">One number, from 1 to 10. The draw happens only when you play.</p>
              <div className="number-grid">
                {numbers.map((number) => (
                  <button
                    ref={number === 1 ? firstNumberRef : null}
                    key={number}
                    className="number-button"
                    type="button"
                    aria-pressed={guess === number}
                    onClick={() => setGuess(number)}
                  >
                    {number}
                  </button>
                ))}
              </div>
              {fields.guess && (
                <p id="guess-error" className="field-error" role="alert">{fields.guess}</p>
              )}
            </fieldset>
            <button className="button primary" type="submit" disabled={!active || Boolean(pending) || uncertain}>
              {pending === 'play' ? 'Drawing…' : 'Play round'}
            </button>
          </form>
          <p className="input-hint" aria-live="polite">
            {pending === 'play' ? 'Committing your round…' : pending === 'stop' ? 'Saving the stopped session…' : ''}
            {pending === 'refresh' ? 'Refreshing saved state…' : ''}
          </p>
          {error && (
            <p className="alert" role="alert">{error}</p>
          )}
          {uncertain && (
            <div className="retry-state">
              <p>Check saved state before playing again. The last request may already have completed.</p>
              <button className="button secondary" onClick={() => command('refresh')} disabled={Boolean(pending)}>
                {pending === 'refresh' ? 'Refreshing…' : 'Refresh saved state'}
              </button>
            </div>
          )}
        </div>
        <aside className="game-results" aria-label="Round results">
          <section className="latest-reveal" aria-labelledby="reveal-title" aria-live="polite" aria-atomic="true">
            <p className="eyebrow">LATEST REVEAL</p>
            <h2 id="reveal-title">{latest ? latest.delta > 0 ? 'A perfect match.' : 'Not this time.' : 'Your next draw awaits.'}</h2>
            {latest ? (
              <>
                <p className="draw-number" aria-label="Drawn number">{latest.draw}</p>
                <p>You chose {latest.guess}. The draw was {latest.draw}.</p>
                <p className={latest.delta > 0 ? 'round-win' : 'round-loss'}>
                  {latest.delta > 0 ? '+' : ''}{latest.delta.toLocaleString()} credits
                </p>
              </>
            ) : (
              <p>No number is drawn until you submit a valid play.</p>
            )}
          </section>
          <section className="round-history" aria-labelledby="history-title">
            <h2 id="history-title">Recent rounds</h2>
            <p className="input-hint">Latest 20, newest first. Saved with your session.</p>
            {session.rounds.length ? (
              <ol className="history-list">
                {session.rounds.map((round) => (
                  <li key={round.id}>
                    <div>
                      <strong>Draw {round.draw} / guess {round.guess}</strong>
                      <span>Stake {round.bet.toLocaleString()} · Balance {round.balance.toLocaleString()}</span>
                    </div>
                    <span className={round.delta > 0 ? 'round-win' : 'round-loss'}>
                      {round.delta > 0 ? '+' : ''}{round.delta.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="history-empty">No rounds yet. Make your first choice at the table.</p>
            )}
          </section>
        </aside>
      </div>
      <div className="summary-actions game-actions">
        <Link className="button secondary" to="/">Back to rules &amp; setup</Link>
        {session.status !== 'stopped' && (
          <button className="button secondary" disabled={Boolean(pending)} onClick={() => command('stop')}>
            {pending === 'stop' ? 'Stopping…' : 'Stop session'}
          </button>
        )}
        {!active && (
          <Link className="button secondary" to="/">Start a new session</Link>
        )}
      </div>
      <p className="input-hint">Fictional credits only. You can stop at any time.</p>
    </section>
  );
}

Game.propTypes = {
  session: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    balance: PropTypes.number.isRequired,
    status: PropTypes.oneOf(['active', 'depleted', 'stopped']).isRequired,
    rounds: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.string.isRequired,
      bet: PropTypes.number.isRequired,
      guess: PropTypes.number.isRequired,
      draw: PropTypes.number.isRequired,
      delta: PropTypes.number.isRequired,
      balance: PropTypes.number.isRequired
    })).isRequired
  }),
  setSession: PropTypes.func.isRequired,
  commands: PropTypes.shape({
    pending: PropTypes.string.isRequired,
    uncertain: PropTypes.bool.isRequired,
    fields: PropTypes.object.isRequired,
    error: PropTypes.string.isRequired,
    setFields: PropTypes.func.isRequired,
    setError: PropTypes.func.isRequired,
    run: PropTypes.func.isRequired
  })
};

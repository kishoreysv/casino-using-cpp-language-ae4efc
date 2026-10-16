/** Introduce the original rules and create a capability-protected fictional-credit session. */
import { useState } from 'react';
import PropTypes from 'prop-types';
import { Link, useNavigate } from 'react-router-dom';
import { startSession } from './api';

/** Render rules, field validation and resilient async submission.
 * Args: session: recovered state or null; setSession: app-owned session updater.
 * Returns: accessible welcome workflow with a visible resume link when available.
 */
export default function Welcome({ session, setSession }) {
  const [name, setName] = useState('');
  const [deposit, setDeposit] = useState('1000');
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();

  /** Validate each input before calling the backend; keep entered values on failure.
   * Args: event: form submission.
   * Returns: resolves after creation or visible failure feedback.
   */
  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    const issues = {};
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 40 || /[\p{Cc}\p{Cf}]/u.test(trimmedName)) {
      issues.name = 'Enter a name of 1–40 characters, without control characters.';
    }
    const credits = Number(deposit);
    if (!deposit.trim() || !Number.isSafeInteger(credits) || credits < 1 || credits > 1000000) {
      issues.deposit = 'Enter a whole number from 1 to 1,000,000.';
    }
    setFields(issues);
    setError('');
    if (Object.keys(issues).length) return;
    setPending(true);
    try {
      const created = await startSession({ name: trimmedName, deposit: credits });
      setSession(created);
      navigate('/play');
    } catch (failure) {
      setFields(failure.fields || {});
      setError(failure.message || 'Could not save your session. Please try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="welcome-layout">
      <section className="introduction" aria-labelledby="welcome-title">
        <p className="eyebrow">A LITTLE INTUITION. A LITTLE LUCK.</p>
        <h1 id="welcome-title">
          One number.
          <br />
          Ten possibilities.
        </h1>
        <p className="lede">Pick your number. Trust your instinct. Make every credit count.</p>
        <section className="rules" aria-labelledby="rules-title">
          <h2 id="rules-title">The house rules</h2>
          <ol>
            <li>Choose a number from 1 to 10. Each draw is random.</li>
            <li>Stake at least 100 credits, never more than your balance.</li>
            <li>A match adds ten times your stake to your balance. Your stake is not deducted first.</li>
            <li>A miss subtracts your stake. Stop whenever you like; below 100 credits, the session ends.</li>
          </ol>
          <p className="fine-print">Fictional credits only. No money, payments, or prizes.</p>
        </section>
      </section>
      <section className="setup-card" aria-labelledby="setup-title">
        <p className="eyebrow">YOUR SEAT AT THE TABLE</p>
        <h2 id="setup-title">Start with a name.</h2>
        <p>Set your starting credits. This session stays with this browser tab.</p>
        {session && (
          <p className="resume-note">
            A session for {session.name} is already saved.
            {' '}
            <Link to="/play">View saved session</Link>
          </p>
        )}
        <form onSubmit={submit} noValidate aria-busy={pending}>
          <div className="field">
            <label htmlFor="player-name">Your name</label>
            <input
              id="player-name"
              name="name"
              autoComplete="nickname"
              maxLength={40}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              aria-required="true"
              aria-invalid={Boolean(fields.name)}
              aria-describedby={fields.name ? 'name-error' : undefined}
              disabled={pending}
            />
            {fields.name && (
              <p id="name-error" className="field-error" role="alert">{fields.name}</p>
            )}
          </div>
          <div className="field">
            <label htmlFor="starting-credits">Starting credits</label>
            <input
              id="starting-credits"
              name="deposit"
              type="number"
              inputMode="numeric"
              min="1"
              max="1000000"
              step="1"
              value={deposit}
              onChange={(event) => setDeposit(event.target.value)}
              required
              aria-required="true"
              aria-invalid={Boolean(fields.deposit)}
              aria-describedby={fields.deposit ? 'credits-hint deposit-error' : 'credits-hint'}
              disabled={pending}
            />
            <p id="credits-hint" className="input-hint">1–1,000,000 whole credits. At least 100 to play.</p>
            {fields.deposit && (
              <p id="deposit-error" className="field-error" role="alert">{fields.deposit}</p>
            )}
          </div>
          {error && (
            <p className="alert" role="alert">{error}</p>
          )}
          <button className="button primary" type="submit" disabled={pending}>
            {pending ? 'Saving your seat…' : session ? 'Start a new session' : 'Start session'}
          </button>
          <p className="input-hint" role="status" aria-live="polite">
            {pending ? 'Creating your session securely…' : 'Your name and balance are saved; your session key stays in this tab.'}
          </p>
        </form>
      </section>
    </div>
  );
}
Welcome.propTypes = {
  session: PropTypes.shape({ name: PropTypes.string.isRequired }),
  setSession: PropTypes.func.isRequired
};

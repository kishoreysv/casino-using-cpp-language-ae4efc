/** Keep authenticated command safety with its session owner, independent of the visible route. */
import { useLayoutEffect, useRef, useState } from 'react';
import { recoverSession, request, stopSession, TOKEN_KEY } from './api';

/** Own pending/uncertain commands and ignore results from replaced sessions or disposed owners.
 * Args: session: current public session; setSession: React session state updater.
 * Returns: command feedback, validation setters and a serialized command runner.
 * Notes: App owns this hook across navigation; standalone Game uses the same safeguards locally.
 */
export default function useSessionCommands(session, setSession) {
  const [pending, setPending] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const owner = useRef(null);
  const id = session?.id;

  useLayoutEffect(() => {
    owner.current = { id, ticket: null, uncertain: false };
    setPending('');
    setUncertain(false);
    // Keep an expired-key error visible in the no-session view.
    if (id) {
      setFields({});
      setError('');
    }
    return () => { owner.current = null; };
  }, [id]);

  /** Serialize a validated command and apply only feedback belonging to this session/request.
   * Args: action: play, stop or refresh; body: validated stake/guess for play.
   * Returns: resolves after accepted feedback or silently discarded obsolete feedback.
   * Notes: Only successful refresh reconciles an uncertain play; stop must not unlock it.
   */
  async function run(action, body) {
    const current = owner.current;
    const active = session?.status === 'active' && session.balance >= 100;
    if (!current || !id || current.ticket || (action === 'play' && (!active || current.uncertain))) return;
    const ticket = Symbol(action);
    const token = sessionStorage.getItem(TOKEN_KEY);
    current.ticket = ticket;
    setPending(action);
    setError('');

    /** Check owner, request and capability identity before changing any state.
     * Args: expired: allow this request's authenticated 401 to have removed its own key.
     * Returns: whether feedback still belongs to the active owner.
     */
    function isCurrent(expired = false) {
      const persisted = sessionStorage.getItem(TOKEN_KEY);
      return owner.current === current && current.ticket === ticket
        && (persisted === token || (expired && persisted === null));
    }

    try {
      let saved;
      if (action === 'play') {
        saved = (await request('/v1/rounds', { method: 'POST', body, token })).session;
      } else if (action === 'stop') {
        saved = await stopSession();
      } else {
        saved = await recoverSession();
      }
      if (!isCurrent()) return;
      setSession((previous) => previous?.id === id ? saved : previous);
      setFields({});
      if (action === 'refresh') {
        current.uncertain = false;
        setUncertain(false);
      }
    } catch (failure) {
      if (!isCurrent(failure.status === 401)) return;
      if (failure.status === 401) setSession((previous) => previous?.id === id ? null : previous);
      setFields(failure.fields || {});
      setError(failure.message);
      if (action === 'play' && (!failure.status || failure.status >= 500 || failure.status === 409)) {
        current.uncertain = true;
        setUncertain(true);
      }
    } finally {
      if (owner.current === current && current.ticket === ticket) {
        current.ticket = null;
        setPending('');
      }
    }
  }

  return { pending, uncertain, fields, error, setFields, setError, run };
}

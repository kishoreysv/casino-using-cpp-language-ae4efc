/** Share same-origin JSON transport and the browser-held session capability across features. */
export const TOKEN_KEY = 'tenfold.session.token';
// The deployment platform's same-origin marker may be empty. Keep our API namespace.
const baseUrl = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

/** Carry a public request failure with HTTP status and per-field details. */
export class ApiError extends Error {
  /** Initialize safe error details.
   * Args: message: user-facing description; status: HTTP code; fields: validation messages.
   */
  constructor(message, status = 0, fields = {}) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

/** Send JSON and attach the capability only when explicitly requested.
 * Args: path: path relative to /api; options: method, body, token and optional abort signal.
 * Returns: parsed JSON object.
 * Raises: ApiError for HTTP/network/timeouts; AbortError for caller cancellation.
 * Notes: authenticated 401 clears only its own still-current capability. Never logs capabilities.
 * @param {string} path
 * @param {{method?: string, body?: object, token?: string, signal?: AbortSignal}} options
 * @returns {Promise<object>}
 */
export async function request(path, { method = 'GET', body, token, signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(cancel, 15000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    if (response.status === 401 && token && sessionStorage.getItem(TOKEN_KEY) === token) {
      sessionStorage.removeItem(TOKEN_KEY);
    }
    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(data.error || 'The request failed. Please try again.', response.status, data.fields);
    }
    return data;
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    throw new ApiError('Could not reach the table. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/** Create a session and persist only its once-returned capability in this tab.
 * Args: input: validated name/deposit form values.
 * Returns: public session received from the backend.
 * Raises: request errors or browser storage denial; caller displays the error.
 * @param {{name: string, deposit: number}} input
 * @returns {Promise<object>}
 */
export async function startSession(input) {
  const result = await request('/v1/sessions', { method: 'POST', body: input });
  sessionStorage.setItem(TOKEN_KEY, result.token);
  return result.session;
}

/** Recover public session state using the tab's capability.
 * Args: signal: optional recovery cancellation signal.
 * Returns: current session from the database.
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
export async function recoverSession(signal) {
  const result = await request('/v1/sessions/current', { token: sessionStorage.getItem(TOKEN_KEY), signal });
  return result.session;
}

/** Stop the tab's session without discarding its recoverable summary.
 * Returns: idempotently stopped public session.
 * @returns {Promise<object>}
 */
export async function stopSession() {
  const result = await request('/v1/sessions/stop', { method: 'POST', token: sessionStorage.getItem(TOKEN_KEY) });
  return result.session;
}

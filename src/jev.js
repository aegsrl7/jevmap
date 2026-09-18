'use strict';

// Jev client (TypeSafe AI "System One" models).
//
// Jev does not generate text: it receives a state (text or JSON) and typed
// questions (choice / score / noul) and answers with typed values,
// probabilities and a confidence. HTTP contract:
//   POST https://api.typesafe.ai/v1/systemone
//   { state, model, questions: { id: { type, instructions, criteria } } }
//   -> { model, answers: { id: {...} }, usage: { input_tokens, output_tokens } }
// Question ids are not shown to the model: every bit of meaning goes into
// `instructions`, and state fields are cited with backticks.
//
// Retry on 408/429/5xx (and on network errors / timeouts) with a 0.5 s -> 1 s
// -> 2 s backoff, `maxRetry` extra attempts (default 2), one AbortController
// timeout per call. The API key is never logged or included in errors.

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const RETRY_STATUS = new Set([408, 429]);
const BACKOFF_MS = [500, 1000, 2000];

// TypeSafe list price per million input tokens, as of 09/2026.
const PRICE_PER_MTOKEN_USD = 0.042;

class JevError extends Error {
  constructor(message, { status = null, body = null, attempts = 0 } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.body = body;
    this.attempts = attempts;
  }
}

function costUsd(tokens) {
  const n = Number(tokens) || 0;
  return (n / 1e6) * PRICE_PER_MTOKEN_USD;
}

function isRetryable(err) {
  if (!(err instanceof JevError)) return false;
  const s = err.status;
  if (s === 0 || s === null) return true; // network error or timeout without status
  return RETRY_STATUS.has(s) || (s >= 500 && s < 600);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Question builders. Criteria for `choice` are keyed objects (or plain strings);
// `score` takes an ordered array of level descriptions; `noul` is a yes/no
// judgement returning a probability.
function choice(instructions, criteria) {
  return { type: 'choice', instructions: String(instructions), criteria };
}

function score(instructions, levels) {
  return { type: 'score', instructions: String(instructions), criteria: levels };
}

function noul(instructions) {
  return { type: 'noul', instructions: String(instructions) };
}

async function httpOnce({ endpoint, apiKey, payload, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) {
      throw new JevError(`Jev request timed out after ${timeoutMs} ms`, { status: 408 });
    }
    throw new JevError(`Jev network error: ${e && e.message ? e.message : String(e)}`, { status: 0 });
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try {
    text = typeof res.text === 'function' ? await res.text() : '';
  } catch (e) {
    throw new JevError(`Jev response could not be read: ${e && e.message ? e.message : String(e)}`, { status: res.status || 0 });
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }

  const status = Number(res.status) || 0;
  const ok = res.ok != null ? Boolean(res.ok) : (status >= 200 && status < 300);
  if (ok && json && typeof json === 'object') return json;
  if (ok) {
    throw new JevError(`Jev returned HTTP ${status} with a non-JSON body`, { status, body: text.slice(0, 500) });
  }
  const detail = (json && (json.error && json.error.message || json.error || json.message)) || text.slice(0, 200);
  throw new JevError(`Jev HTTP ${status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, {
    status,
    body: json || text.slice(0, 500),
  });
}

/**
 * Build a Jev client bound to an API key.
 *
 * @param {object} options
 * @param {string} options.apiKey        TYPESAFE_API_KEY (required, never printed)
 * @param {string} [options.model]       default JEV_MODEL or 'jev-latest'
 * @param {number} [options.timeoutMs]   per call, default 30000
 * @param {number} [options.maxRetry]    extra attempts on 408/429/5xx, default 2
 * @param {function} [options.fetchImpl] fetch implementation (tests inject a fake)
 * @param {string} [options.endpoint]    default https://api.typesafe.ai/v1/systemone
 * @returns {{ ask(state, questions): Promise<{ answers, usage, model, ms, attempts }> }}
 */
function createJevClient({
  apiKey,
  model = process.env.JEV_MODEL || DEFAULT_MODEL,
  timeoutMs = 30000,
  maxRetry = 2,
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  if (!apiKey) throw new JevError('TYPESAFE_API_KEY is missing');
  if (typeof fetchImpl !== 'function') throw new JevError('No fetch implementation available (Node >= 18 required)');
  const retries = Math.max(0, Number(maxRetry) || 0);
  const timeout = Math.max(1, Number(timeoutMs) || 30000);

  async function ask(state, questions) {
    if (!questions || typeof questions !== 'object' || !Object.keys(questions).length) {
      throw new JevError('ask(state, questions) needs at least one question');
    }
    const payload = { state, model, questions };
    const t0 = Date.now();
    let attempts = 0;
    let last = null;
    while (attempts <= retries) {
      attempts++;
      try {
        const json = await httpOnce({ endpoint, apiKey, payload, timeoutMs: timeout, fetchImpl });
        return {
          answers: json.answers || {},
          usage: json.usage || { input_tokens: 0, output_tokens: 0 },
          model: json.model || model,
          ms: Date.now() - t0,
          attempts,
        };
      } catch (e) {
        last = e instanceof JevError ? e : new JevError(e && e.message ? e.message : String(e), { status: 0 });
        if (!isRetryable(last) || attempts > retries) break;
        await sleep(BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
      }
    }
    last.attempts = attempts;
    throw last;
  }

  return { ask, model, endpoint, timeoutMs: timeout, maxRetry: retries };
}

// One-shot convenience wrapper with the shape described in CONTRACT.md.
async function jevRequest({ state, questions, apiKey, model, timeoutMs, maxRetry, fetchImpl, endpoint } = {}) {
  const client = createJevClient({ apiKey, model, timeoutMs, maxRetry, fetchImpl, endpoint });
  return client.ask(state, questions);
}

module.exports = {
  JevError,
  createJevClient,
  jevRequest,
  choice,
  score,
  noul,
  costUsd,
  PRICE_PER_MTOKEN_USD,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
};

'use strict';

// Minimal Anthropic Messages API client: one HTTPS POST, no SDK, no
// dependencies. Used by `describe` (fill missing unit descriptions) and by the
// composite task splitter. Returns the first JSON object found in the answer.
// The API key is never logged or included in errors.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Extract the first balanced {...} object from a text (the model sometimes
// wraps JSON in prose or code fences). Returns the parsed object or null.
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  // Fast path: first '{' to last '}'.
  const last = s.lastIndexOf('}');
  if (last > start) {
    try { return JSON.parse(s.slice(start, last + 1)); } catch (_) { /* fall through */ }
  }
  // Slow path: scan for the first balanced object, honouring strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

/**
 * Ask an Anthropic model for a JSON answer.
 *
 * @param {object} options
 * @param {string} options.apiKey        ANTHROPIC_API_KEY (required)
 * @param {string} [options.model]       default 'claude-haiku-4-5'
 * @param {string} [options.system]      system prompt
 * @param {string} options.user          user message
 * @param {number} [options.maxTokens]   default 800
 * @param {number} [options.timeoutMs]   default 30000
 * @param {function} [options.fetchImpl] fetch implementation (tests inject a fake)
 * @returns {Promise<{ json: object, usage: { input_tokens, output_tokens }, raw: string }>}
 */
async function anthropicJson({
  apiKey,
  model = DEFAULT_MODEL,
  system,
  user,
  maxTokens = 800,
  timeoutMs = 30000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is missing');
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available (Node >= 18 required)');
  if (user == null || String(user).trim() === '') throw new Error('anthropicJson needs a user message');

  const payload = {
    model,
    max_tokens: Math.max(1, Number(maxTokens) || 800),
    messages: [{ role: 'user', content: String(user) }],
  };
  if (system) payload.system = String(system);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 30000));
  let res;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted || (e && e.name === 'AbortError')) {
      throw new Error(`Anthropic request timed out after ${timeoutMs} ms`);
    }
    throw new Error(`Anthropic network error: ${e && e.message ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = typeof res.text === 'function' ? await res.text() : '';
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  const status = Number(res.status) || 0;
  const ok = res.ok != null ? Boolean(res.ok) : (status >= 200 && status < 300);
  if (!ok) {
    const detail = (body && body.error && body.error.message) || text.slice(0, 200);
    const err = new Error(`Anthropic HTTP ${status}: ${detail}`);
    err.status = status;
    err.body = body || text.slice(0, 500);
    throw err;
  }
  if (!body || !Array.isArray(body.content)) {
    throw new Error('Anthropic response has no content blocks');
  }

  const raw = body.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
  const json = extractJson(raw);
  if (!json || typeof json !== 'object') {
    throw new Error(`Anthropic answer contains no JSON object: ${raw.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  const usage = body.usage || {};
  return {
    json,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    },
    raw,
  };
}

module.exports = { anthropicJson, extractJson, ANTHROPIC_URL, ANTHROPIC_VERSION, DEFAULT_MODEL };

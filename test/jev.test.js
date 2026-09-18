'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createJevClient, JevError, choice, score, noul, costUsd, PRICE_PER_MTOKEN_USD, jevRequest } = require('../src/jev');

const QUESTIONS = { q0: noul('The task in `task` needs this unit: a.js | function f') };

function fakeResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

test('success path: sends the contract payload and returns answers, usage, model, ms, attempts', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse(200, { model: 'jev-1', answers: { q0: { noul: 0.87 } }, usage: { input_tokens: 120, output_tokens: 3 } });
  };
  const client = createJevClient({ apiKey: 'secret-key', model: 'jev-latest', fetchImpl });
  const res = await client.ask({ task: 'fix the email list' }, QUESTIONS);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.ok(calls[0].init.signal, 'an AbortSignal is passed to fetch');
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { state: { task: 'fix the email list' }, model: 'jev-latest', questions: QUESTIONS });

  assert.equal(res.answers.q0.noul, 0.87);
  assert.equal(res.usage.input_tokens, 120);
  assert.equal(res.model, 'jev-1');
  assert.equal(res.attempts, 1);
  assert.ok(typeof res.ms === 'number' && res.ms >= 0);
});

test('retries on 503 then succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return fakeResponse(503, { error: 'busy' });
    return fakeResponse(200, { answers: { q0: { noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  };
  const client = createJevClient({ apiKey: 'k', fetchImpl, maxRetry: 2 });
  const res = await client.ask({ task: 't' }, QUESTIONS);
  assert.equal(n, 2);
  assert.equal(res.attempts, 2);
  assert.equal(res.answers.q0.noul, 0.5);
});

test('timeout: a never-resolving fetch is aborted after timeoutMs', async () => {
  let signalSeen = null;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    signalSeen = init.signal;
    init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const client = createJevClient({ apiKey: 'k', fetchImpl, timeoutMs: 50, maxRetry: 0 });
  const t0 = Date.now();
  await assert.rejects(client.ask({ task: 't' }, QUESTIONS), (e) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.status, 408);
    assert.match(e.message, /timed out after 50 ms/);
    return true;
  });
  assert.ok(signalSeen && signalSeen.aborted, 'the AbortController fired');
  assert.ok(Date.now() - t0 < 2000, 'did not wait for the never-resolving promise');
});

test('401 throws a JevError with status and body, without retrying', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return fakeResponse(401, { error: { message: 'invalid api key' } }); };
  const client = createJevClient({ apiKey: 'k', fetchImpl });
  await assert.rejects(client.ask({ task: 't' }, QUESTIONS), (e) => {
    assert.ok(e instanceof JevError);
    assert.equal(e.name, 'JevError');
    assert.equal(e.status, 401);
    assert.deepEqual(e.body, { error: { message: 'invalid api key' } });
    assert.match(e.message, /401/);
    assert.equal(e.attempts, 1);
    assert.ok(!e.message.includes('Bearer k'), 'the key never appears in the message');
    return true;
  });
  assert.equal(n, 1);
});

test('gives up after maxRetry on repeated 5xx', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return fakeResponse(500, 'oops'); };
  const client = createJevClient({ apiKey: 'k', fetchImpl, maxRetry: 1 });
  await assert.rejects(client.ask({ task: 't' }, QUESTIONS), (e) => e instanceof JevError && e.status === 500 && e.attempts === 2);
  assert.equal(n, 2);
});

test('missing key is a JevError at construction', () => {
  assert.throws(() => createJevClient({ apiKey: '' }), JevError);
});

test('jevRequest is a one-shot wrapper', async () => {
  const fetchImpl = async () => fakeResponse(200, { answers: { q0: { noul: 0.2 } }, usage: { input_tokens: 5 } });
  const res = await jevRequest({ state: { task: 't' }, questions: QUESTIONS, apiKey: 'k', fetchImpl });
  assert.equal(res.answers.q0.noul, 0.2);
});

test('question builders and cost', () => {
  assert.deepEqual(choice('pick', { a: 'A', b: { what: 'B' } }), { type: 'choice', instructions: 'pick', criteria: { a: 'A', b: { what: 'B' } } });
  assert.deepEqual(score('rate', ['low', 'high']), { type: 'score', instructions: 'rate', criteria: ['low', 'high'] });
  assert.deepEqual(noul('is it'), { type: 'noul', instructions: 'is it' });
  assert.equal(PRICE_PER_MTOKEN_USD, 0.042);
  assert.equal(costUsd(1e6), 0.042);
  assert.equal(costUsd(0), 0);
  assert.ok(Math.abs(costUsd(51000) - 0.002142) < 1e-9);
});

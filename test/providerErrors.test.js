const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

let isAbortedRequestError;
try {
  ({ isAbortedRequestError } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test('recognizes a DOM-style AbortError', () => {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  assert.equal(isAbortedRequestError(error), true);
});

test('recognizes undici TypeError("terminated") with no cause', () => {
  assert.equal(isAbortedRequestError(new TypeError('terminated')), true);
});

test('recognizes an abort wrapped as the cause of a fetch failure', () => {
  const abort = new Error('This operation was aborted');
  abort.name = 'AbortError';
  assert.equal(isAbortedRequestError(new TypeError('fetch failed', { cause: abort })), true);
});

test('recognizes a terminated error nested deeper in the cause chain', () => {
  const nested = new TypeError('fetch failed', { cause: new TypeError('terminated') });
  assert.equal(isAbortedRequestError(nested), true);
});

test('guards against cyclic cause chains without infinite recursion or stack overflow', () => {
  const cyclic = new Error('cyclic error');
  cyclic.cause = cyclic;
  assert.equal(isAbortedRequestError(cyclic), false);

  const a = new Error('cycle a');
  const b = new Error('cycle b');
  a.cause = b;
  b.cause = a;
  assert.equal(isAbortedRequestError(a), false);
});

test('does not classify a genuine connection failure as an abort', () => {
  const refused = new Error('connect ECONNREFUSED 127.0.0.1:11434');
  refused.name = 'Error';
  assert.equal(isAbortedRequestError(new TypeError('fetch failed', { cause: refused })), false);
});

test('does not classify an HTTP error or non-objects as an abort', () => {
  assert.equal(isAbortedRequestError(new Error('Ollama /api/chat failed with HTTP 500')), false);
  assert.equal(isAbortedRequestError(undefined), false);
  assert.equal(isAbortedRequestError(null), false);
  assert.equal(isAbortedRequestError('terminated'), false);
});

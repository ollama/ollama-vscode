const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class CancellationError extends Error {}

const vscode = {
  CancellationError,
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; } cancel() {} dispose() {} },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart: class {},
  LanguageModelDataPart: class {},
  LanguageModelToolCallPart: class {},
  LanguageModelToolResultPart: class {},
  lm: { registerLanguageModelChatProvider: () => ({ dispose() {} }) },
  window: { showErrorMessage: () => undefined, createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  Uri: { parse: (v) => v },
  env: { openExternal: () => undefined }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
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

test('recognizes undici\'s TypeError("terminated") with no cause', () => {
  // undici attaches `cause` only when the abort reason is error-like, so a
  // socket-close abort carries the message alone.
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

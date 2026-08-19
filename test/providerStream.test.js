const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

let isMissingStreamCompletionError;
try {
  ({ isMissingStreamCompletionError } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test('recognises the Ollama client missing-completion error', () => {
  assert.equal(
    isMissingStreamCompletionError(new Error('Did not receive done or success response in stream.')),
    true
  );
});

test('does not hide unrelated stream errors', () => {
  assert.equal(isMissingStreamCompletionError(new Error('connection reset')), false);
  assert.equal(isMissingStreamCompletionError('stream ended'), false);
});

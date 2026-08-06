const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateModelTokenLimits, resolveMaxContextLength } = require('../out/modelLimits');

const fallbackContextWindow = 32768;
const defaultMaxOutputTokens = 4096;

function limits(contextWindow, configuredMaxContextLength, explicitMaxInputTokens, explicitMaxOutputTokens) {
  return calculateModelTokenLimits(
    contextWindow,
    explicitMaxInputTokens,
    explicitMaxOutputTokens,
    configuredMaxContextLength,
    fallbackContextWindow,
    defaultMaxOutputTokens
  );
}

test('keeps the discovered model context when no server limit is configured', () => {
  assert.deepEqual(limits(131072), {
    maxInputTokens: 126976,
    maxOutputTokens: 4096
  });
});

test('caps the advertised model context at the configured server limit', () => {
  assert.deepEqual(limits(131072, 65536), {
    maxInputTokens: 61440,
    maxOutputTokens: 4096
  });
});

test('does not raise a model context when the configured limit is larger', () => {
  assert.deepEqual(limits(8192, 65536), {
    maxInputTokens: 4096,
    maxOutputTokens: 4096
  });
});

test('uses the configured server limit when model metadata has no context', () => {
  assert.deepEqual(limits(undefined, 16384), {
    maxInputTokens: 12288,
    maxOutputTokens: 4096
  });
});

test('does not raise an explicit input limit while applying the server cap', () => {
  assert.deepEqual(limits(undefined, 65536, 8000, 2000), {
    maxInputTokens: 8000,
    maxOutputTokens: 2000
  });
});

test('keeps at least one input token for very small contexts', () => {
  assert.deepEqual(limits(1, 1), {
    maxInputTokens: 1,
    maxOutputTokens: 0
  });
});

test('prefers a valid provider context limit over the global setting', () => {
  assert.equal(resolveMaxContextLength(65536, 32768), 65536);
});

test('falls back to the global setting when the provider value is invalid', () => {
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '65536']) {
    assert.equal(resolveMaxContextLength(value, 32768), 32768);
  }
});

test('ignores invalid context limits', () => {
  for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '65536']) {
    assert.equal(resolveMaxContextLength(value, value), undefined);
  }
});

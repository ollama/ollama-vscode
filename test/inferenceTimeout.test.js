const assert = require('node:assert/strict');
const test = require('node:test');
const {
  defaultInferenceTimeoutMinutes,
  inferenceTimeoutMilliseconds,
  maximumInferenceTimeoutMinutes,
  minimumInferenceTimeoutMinutes
} = require('../out/inferenceTimeout');

test('uses the configured inference timeout in minutes', () => {
  assert.equal(inferenceTimeoutMilliseconds(30), 30 * 60 * 1000);
  assert.equal(inferenceTimeoutMilliseconds(minimumInferenceTimeoutMinutes), 60 * 1000);
  assert.equal(inferenceTimeoutMilliseconds(maximumInferenceTimeoutMinutes), 60 * 60 * 1000);
});

test('falls back to the finite default for invalid inference timeouts', () => {
  const fallback = defaultInferenceTimeoutMinutes * 60 * 1000;
  for (const value of [
    undefined,
    null,
    '30',
    0,
    -1,
    1.5,
    maximumInferenceTimeoutMinutes + 1,
    NaN,
    Infinity
  ]) {
    assert.equal(inferenceTimeoutMilliseconds(value), fallback, String(value));
  }
});

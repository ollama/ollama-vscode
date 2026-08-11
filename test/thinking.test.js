const assert = require('node:assert/strict');
const test = require('node:test');

const {
  supportedThinkingLevel,
  thinkingPolicy,
  toOllamaThinkValue
} = require('../out/thinking');

test('uses documented GPT-OSS effort levels and does not offer disabling', () => {
  assert.deepEqual(thinkingPolicy('gpt-oss:20b'), {
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium'
  });
  assert.deepEqual(thinkingPolicy('custom-name', 'gptoss'), {
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'medium'
  });
});

test('uses documented DeepSeek V4 non-thinking, high, and max modes', () => {
  const expected = {
    levels: ['none', 'high', 'max'],
    defaultLevel: 'none'
  };

  assert.deepEqual(thinkingPolicy('deepseek-v4-flash:cloud'), expected);
  assert.deepEqual(thinkingPolicy('deepseek-v4-pro:cloud'), expected);
});

test('uses documented GLM 5.2 high and max effort levels', () => {
  const expected = {
    levels: ['high', 'max'],
    defaultLevel: 'high'
  };

  assert.deepEqual(thinkingPolicy('glm-5.2:cloud'), expected);
  assert.deepEqual(thinkingPolicy('custom-name', 'glm5.2'), expected);
});

test('does not expose a control for models without a verified mapping', () => {
  assert.equal(thinkingPolicy('qwen3.6:35b'), undefined);
  assert.equal(thinkingPolicy('my-deepseek-v4-experiment'), undefined);
});

test('translates UI thinking levels to Ollama request values', () => {
  assert.equal(toOllamaThinkValue(undefined), undefined);
  assert.equal(toOllamaThinkValue('none'), false);
  assert.equal(toOllamaThinkValue('low'), 'low');
  assert.equal(toOllamaThinkValue('medium'), 'medium');
  assert.equal(toOllamaThinkValue('high'), 'high');
  assert.equal(toOllamaThinkValue('max'), 'max');
});

test('accepts only levels supported by the selected model policy', () => {
  const gptOSS = thinkingPolicy('gpt-oss:20b');
  assert.equal(supportedThinkingLevel(gptOSS, undefined), 'medium');
  assert.equal(supportedThinkingLevel(gptOSS, 'low'), 'low');
  assert.equal(supportedThinkingLevel(gptOSS, 'none'), undefined);

  const deepSeekV4 = thinkingPolicy('deepseek-v4-flash:cloud');
  assert.equal(supportedThinkingLevel(deepSeekV4, undefined), 'none');
  assert.equal(supportedThinkingLevel(deepSeekV4, 'max'), 'max');
  assert.equal(supportedThinkingLevel(deepSeekV4, 'low'), undefined);

  const glm52 = thinkingPolicy('glm-5.2:cloud');
  assert.equal(supportedThinkingLevel(glm52, undefined), 'high');
  assert.equal(supportedThinkingLevel(glm52, 'high'), 'high');
  assert.equal(supportedThinkingLevel(glm52, 'medium'), undefined);
});

test('omits stale configuration for models without a verified policy', () => {
  assert.equal(supportedThinkingLevel(undefined, 'high'), undefined);
  assert.equal(supportedThinkingLevel(undefined, 'invalid'), undefined);
});

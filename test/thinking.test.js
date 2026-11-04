const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractThinkingFromModelConfiguration,
  formatThinkingItemLabel,
  resolveEffectiveThinking,
  supportedThinkingLevel,
  thinkingConfigurationSchema,
  thinkingPolicy
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
    levels: [false, 'high', 'max'],
    defaultLevel: false
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

test('uses Qwen3.8 metadata without inventing high/max aliases or a default', () => {
  for (const defaultLevel of ['medium', 'xhigh']) {
    const policy = thinkingPolicy('qwen3.8:27b', 'qwen35', {
      values: [false, 'low', 'medium', 'xhigh'], default: defaultLevel
    });
    assert.deepEqual(policy, { levels: [false, 'low', 'medium', 'xhigh'], defaultLevel });
    for (const value of policy.levels) assert.equal(supportedThinkingLevel(policy, value), value);
    for (const value of ['high', 'max', 'none', true, null, 1, {}, '']) {
      assert.equal(supportedThinkingLevel(policy, value), undefined);
    }
  }
  assert.equal(thinkingPolicy('qwen3.8:27b', 'qwen35'), undefined);
});

test('metadata overrides old mappings and supports exact boolean and named values', () => {
  assert.deepEqual(thinkingPolicy('glm-5.2:cloud', undefined, {
    values: [false, 'high', 'max'], default: 'high'
  }), { levels: [false, 'high', 'max'], defaultLevel: 'high' });
  assert.deepEqual(thinkingPolicy('custom-model', undefined, {
    values: [false, true], default: true
  }), { levels: [false, true], defaultLevel: true });
  const policy = thinkingPolicy('custom-model', undefined, {
    values: ['brief', 'deep'], default: 'brief'
  });
  assert.equal(supportedThinkingLevel(policy, 'deep'), 'deep');
  assert.equal(supportedThinkingLevel(policy, 'high'), undefined);
});

test('non-configurable or malformed metadata hides controls instead of falling back', () => {
  for (const metadata of [null, false, {}, {values: []},
    { values: [false], default: false }, { values: [true], default: true },
    { values: ['high', 'high'], default: 'high' },
    { values: ['low', 'high'], default: 'medium' },
    { values: ['low', 5], default: 'low' }, { values: ['', 'high'], default: 'high' }
  ]) assert.equal(thinkingPolicy('gpt-oss:20b', 'gptoss', metadata), undefined);
});

test('accepts only levels supported by the selected model policy', () => {
  const gptOSS = thinkingPolicy('gpt-oss:20b');
  assert.equal(supportedThinkingLevel(gptOSS, undefined), undefined);
  assert.equal(supportedThinkingLevel(gptOSS, 'low'), 'low');
  assert.equal(supportedThinkingLevel(gptOSS, 'none'), undefined);

  const deepSeekV4 = thinkingPolicy('deepseek-v4-flash:cloud');
  assert.equal(supportedThinkingLevel(deepSeekV4, undefined), undefined);
  assert.equal(supportedThinkingLevel(deepSeekV4, 'max'), 'max');
  assert.equal(supportedThinkingLevel(deepSeekV4, 'low'), undefined);

  const glm52 = thinkingPolicy('glm-5.2:cloud');
  assert.equal(supportedThinkingLevel(glm52, undefined), undefined);
  assert.equal(supportedThinkingLevel(glm52, 'high'), 'high');
  assert.equal(supportedThinkingLevel(glm52, 'medium'), undefined);
});

test('omits stale configuration for models without a verified policy', () => {
  assert.equal(supportedThinkingLevel(undefined, 'high'), undefined);
  assert.equal(supportedThinkingLevel(undefined, 'invalid'), undefined);
});

test('builds configuration schema for configurable models with server default and exact levels', () => {
  const gptOSS = thinkingPolicy('gpt-oss:20b');
  const schema = thinkingConfigurationSchema(gptOSS);
  assert.ok(schema);
  assert.deepEqual(schema.properties.reasoningEffort, {
    type: ['string', 'boolean'],
    title: 'Thinking Effort',
    description: 'Thinking effort for this model.',
    group: 'navigation',
    enum: ['default', 'low', 'medium', 'high'],
    enumItemLabels: ['Use server default', 'Low', 'Medium', 'High'],
    default: 'default'
  });

  const deepseek = thinkingPolicy('deepseek-v4-flash:cloud');
  const deepseekSchema = thinkingConfigurationSchema(deepseek);
  assert.ok(deepseekSchema);
  assert.deepEqual(deepseekSchema.properties.reasoningEffort.enum, ['default', false, 'high', 'max']);
  assert.deepEqual(deepseekSchema.properties.reasoningEffort.enumItemLabels, ['Use server default', 'false', 'High', 'Max']);
  assert.equal(deepseekSchema.properties.reasoningEffort.default, 'default');
});

test('configuration schema reflects supported user override as default', () => {
  const gptOSS = thinkingPolicy('gpt-oss:20b');
  assert.equal(thinkingConfigurationSchema(gptOSS, 'high').properties.reasoningEffort.default, 'high');
  assert.equal(thinkingConfigurationSchema(gptOSS, 'unsupported').properties.reasoningEffort.default, 'default');

  const deepseek = thinkingPolicy('deepseek-v4-flash:cloud');
  assert.equal(thinkingConfigurationSchema(deepseek, false).properties.reasoningEffort.default, false);
});

test('does not build configuration schema for unverified or single-level models', () => {
  assert.equal(thinkingConfigurationSchema(undefined), undefined);
  assert.equal(thinkingConfigurationSchema({ levels: [false], defaultLevel: false }), undefined);
});

test('extractThinkingFromModelConfiguration extracts effort keys or returns undefined', () => {
  assert.equal(extractThinkingFromModelConfiguration({ reasoningEffort: 'low' }), 'low');
  assert.equal(extractThinkingFromModelConfiguration({ thinkingLevel: 'high' }), 'high');
  assert.equal(extractThinkingFromModelConfiguration({ think: false }), false);
  assert.equal(extractThinkingFromModelConfiguration(undefined), undefined);
  assert.equal(extractThinkingFromModelConfiguration(null), undefined);
  assert.equal(extractThinkingFromModelConfiguration('string'), undefined);
  assert.equal(extractThinkingFromModelConfiguration([]), undefined);
});

test('resolveEffectiveThinking handles dropdown, server default, and settings fallback', () => {
  const gptOSS = thinkingPolicy('gpt-oss:20b');

  // Dropdown selection takes precedence
  const chosen = resolveEffectiveThinking(gptOSS, { reasoningEffort: 'high' }, 'low');
  assert.equal(chosen.thinkingLevel, 'high');
  assert.equal(chosen.persistedSettingValue, 'high');

  // Server default clears override and omits think
  const defaulted = resolveEffectiveThinking(gptOSS, { reasoningEffort: 'default' }, 'low');
  assert.equal(defaulted.thinkingLevel, undefined);
  assert.equal(defaulted.shouldClearPersistedSetting, true);

  // Settings fallback when modelConfiguration is absent
  const fallback = resolveEffectiveThinking(gptOSS, undefined, 'low');
  assert.equal(fallback.thinkingLevel, 'low');
  assert.equal(fallback.persistedSettingValue, undefined);

  // Unsupported dropdown value omits think
  const invalid = resolveEffectiveThinking(gptOSS, { reasoningEffort: 'none' }, 'low');
  assert.equal(invalid.thinkingLevel, undefined);
});

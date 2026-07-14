const assert = require('node:assert/strict');
const test = require('node:test');
const {
  builtInModelRecommendations,
  isOutdatedAgentModel,
  isRecommendedModel,
  OutdatedModelWarningTracker,
  parseModelRecommendations,
  recommendedReplacement
} = require('../out/recommendations');

test('provides Ollama launch recommendations as a fail-open fallback', () => {
  assert.deepEqual(
    builtInModelRecommendations.map(recommendation => recommendation.model),
    [
      'kimi-k2.6:cloud',
      'qwen3.5:cloud',
      'glm-5.1:cloud',
      'minimax-m2.7:cloud',
      'gemma4:12b',
      'qwen3.5'
    ]
  );
  assert.equal(
    builtInModelRecommendations.some(recommendation => isOutdatedAgentModel(recommendation.model)),
    false
  );
});

test('parses valid recommendations and ignores invalid or duplicate entries', () => {
  assert.deepEqual(parseModelRecommendations({ recommendations: [
    { model: ' qwen3.6 ', description: ' Coding locally ' },
    { model: 'qwen3.6:latest', description: 'duplicate alias' },
    { model: 'gemma4', description: 'pin the recommended size' },
    { model: 'gemma4:latest', description: 'duplicate pinned alias' },
    { model: '' },
    { description: 'missing model' },
    null
  ] }), [
    { model: 'qwen3.6' },
    { model: 'gemma4:12b' }
  ]);
  assert.deepEqual(parseModelRecommendations({}), []);
});

test('identifies recommended models by their underlying model names', () => {
  const recommendations = [{ model: 'gemma4:12b' }, { model: 'qwen3.5:cloud' }];

  assert.equal(isRecommendedModel('gemma4:12b', recommendations), true);
  assert.equal(isRecommendedModel('gemma4:latest', recommendations), false);
  assert.equal(isRecommendedModel('qwen3.5:cloud', recommendations), true);
  assert.equal(isRecommendedModel('library/gemma4:latest', recommendations), false);
  assert.equal(isRecommendedModel('qwen2.5-coder:7b', recommendations), false);
});

test('chooses an installed replacement with the same local or cloud source', () => {
  const models = [
    { name: 'qwen3.6:latest' },
    { name: 'glm-5.2:cloud' }
  ];
  const recommendations = [
    { model: 'glm-5.2:cloud' },
    { model: 'qwen3.6' }
  ];

  assert.equal(recommendedReplacement('qwen2.5-coder:7b', models, recommendations), 'qwen3.6:latest');
  assert.equal(recommendedReplacement('llama3.2:cloud', models, recommendations), 'glm-5.2:cloud');
});

test('shows a pinned Gemma 4 recommendation even before it is installed', () => {
  const recommendations = parseModelRecommendations({
    recommendations: [{ model: 'gemma4' }]
  });

  assert.equal(
    recommendedReplacement(
      'llama3.1:latest',
      [{ name: 'gemma4:latest' }, { name: 'gemma4:12b' }],
      recommendations
    ),
    'gemma4:12b'
  );
  assert.equal(
    recommendedReplacement('llama3.1:latest', [{ name: 'gemma4:latest' }], recommendations),
    'gemma4:12b'
  );
});

test('does not recommend a replacement from a different source', () => {
  assert.equal(
    recommendedReplacement(
      'qwen2.5-coder:7b',
      [{ name: 'glm-5.2:cloud' }],
      [{ model: 'glm-5.2:cloud' }]
    ),
    undefined
  );
  assert.equal(
    recommendedReplacement(
      'llama3.2:cloud',
      [{ name: 'qwen3.6:latest' }],
      [{ model: 'qwen3.6' }]
    ),
    undefined
  );
});

test('classifies only the agreed outdated agent model families and tags', () => {
  for (const model of [
    'qwen2.5',
    'qwen2.5-coder:7b',
    'library/llama3.2:latest',
    'codellama:13b-code',
    'mistral:7b',
    'starcoder:15b',
    'deepseek-r1:32b-cloud'
  ]) {
    assert.equal(isOutdatedAgentModel(model), true, model);
  }
  for (const model of [
    'qwen3.6',
    'my-qwen2.5-coder:7b',
    'llama3.2-inspired',
    'mixtral:8x7b',
    'starcoder2:15b',
    'deepseek-r1:70b'
  ]) {
    assert.equal(isOutdatedAgentModel(model), false, model);
  }
});

test('tracks each outdated model independently as a conversation grows', () => {
  const tracker = new OutdatedModelWarningTracker();
  const firstTurn = tracker.beginRequest(['user: fix this'], false);

  assert.equal(tracker.hasShown(firstTurn, 'qwen2.5-coder:7b'), false);
  tracker.markShown(firstTurn, 'qwen2.5-coder:7b');
  tracker.finishRequest(firstTurn, true);

  const nextTurn = tracker.beginRequest(
    ['user: fix this', 'assistant: done', 'user: one more change'],
    true
  );
  assert.equal(tracker.hasShown(nextTurn, 'QWEN2.5-CODER:7B'), true);
  assert.equal(tracker.hasShown(nextTurn, 'llama3.2:latest'), false);
});

test('does not repeat a warning when the first request is retried after failure', () => {
  const tracker = new OutdatedModelWarningTracker();
  const firstAttempt = tracker.beginRequest(['user: fix this'], false);
  tracker.markShown(firstAttempt, 'qwen2.5-coder:7b');
  tracker.finishRequest(firstAttempt, false);

  const retry = tracker.beginRequest(['user: fix this'], false);
  assert.equal(tracker.hasShown(retry, 'qwen2.5-coder:7b'), true);
});

test('keeps warning state separate for new chats with the same first prompt', () => {
  const tracker = new OutdatedModelWarningTracker();
  const firstChat = tracker.beginRequest(['user: fix this'], false);
  tracker.markShown(firstChat, 'qwen2.5-coder:7b');
  tracker.finishRequest(firstChat, true);

  const secondChat = tracker.beginRequest(['user: fix this'], false);
  assert.equal(tracker.hasShown(secondChat, 'qwen2.5-coder:7b'), false);
});

test('warns after switching from a current model in a new chat with a repeated prompt', () => {
  const tracker = new OutdatedModelWarningTracker();
  const firstChat = tracker.beginRequest(['user: fix this'], false);
  tracker.markShown(firstChat, 'qwen2.5-coder:7b');
  tracker.finishRequest(firstChat, true);

  const secondChat = tracker.beginRequest(['user: fix this'], false);
  tracker.finishRequest(secondChat, true);
  const switchedModel = tracker.beginRequest(
    ['user: fix this', 'assistant: a different response'],
    true
  );
  assert.equal(tracker.hasShown(switchedModel, 'qwen2.5-coder:7b'), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  builtInModelRecommendations,
  isOutdatedAgentModel,
  isRecommendedModel,
  OutdatedModelWarningTracker,
  parseModelRecommendations,
  recommendedReplacement
} from '../src/recommendations';

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
    { model: '' },
    { description: 'missing model' },
    null
  ] }), [
    { model: 'qwen3.6' }
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

test('tracks each outdated model independently within a chat', () => {
  const tracker = new OutdatedModelWarningTracker();

  assert.equal(tracker.hasShown('chat-a', 'qwen2.5-coder:7b'), false);
  tracker.markShown('chat-a', 'qwen2.5-coder:7b');
  assert.equal(tracker.hasShown('chat-a', 'QWEN2.5-CODER:7B'), true);
  assert.equal(tracker.hasShown('chat-a', 'llama3.2:latest'), false);
  assert.equal(tracker.hasShown('chat-b', 'qwen2.5-coder:7b'), false);
});

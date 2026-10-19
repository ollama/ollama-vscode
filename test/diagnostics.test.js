const assert = require('node:assert/strict');
const test = require('node:test');
const {
  inspectOllamaModels,
  loadedModelContextDiagnosticLines,
  maximumSupportedContextLength,
  OllamaDiagnosticsConfigurationTracker,
  ollamaDiagnosticsClientOptions,
  thinkingDiagnosticLines
} = require('../out/diagnostics');

test('uses the most recently resolved provider group when the workspace endpoint differs', () => {
  const tracker = new OllamaDiagnosticsConfigurationTracker();
  const workspaceConfiguration = {
    url: 'https://workspace.example.test',
    headers: { Authorization: 'Bearer workspace' }
  };
  tracker.recordResolved({
    url: 'https://previous-provider.example.test',
    headers: { Authorization: 'Bearer previous-provider' }
  });
  tracker.recordResolved({
    url: 'https://provider.example.test',
    headers: { Authorization: 'Bearer provider' },
    maxContextLength: 32768
  });

  const selected = tracker.select(workspaceConfiguration);

  assert.equal(selected.source, 'resolved-provider-group');
  assert.deepEqual(selected.configuration, {
    url: 'https://provider.example.test',
    headers: { Authorization: 'Bearer provider' },
    maxContextLength: 32768
  });
});

test('prefers the most recently used provider group for diagnostics', () => {
  const tracker = new OllamaDiagnosticsConfigurationTracker();
  tracker.recordResolved({
    url: 'https://resolved.example.test',
    headers: { 'X-Ollama-Group': 'resolved' }
  });
  tracker.recordUsed({
    url: 'https://used.example.test',
    headers: { 'X-Ollama-Group': 'used' },
    maxContextLength: 8192
  });

  const selected = tracker.select({
    url: 'https://workspace.example.test',
    headers: {}
  });

  assert.equal(selected.source, 'used-provider-group');
  assert.deepEqual(selected.configuration, {
    url: 'https://used.example.test',
    headers: { 'X-Ollama-Group': 'used' },
    maxContextLength: 8192
  });
});

test('preserves endpoint, string headers, and cancellation-aware fetch in client options', () => {
  const request = async () => new Response();
  const options = ollamaDiagnosticsClientOptions(
    'https://ollama.example.test',
    {
      Authorization: 'Bearer secret',
      'X-Ollama-Count': 2,
      'X-Ollama-Disabled': false
    },
    request
  );

  assert.equal(options.host, 'https://ollama.example.test');
  assert.deepEqual(options.headers, { Authorization: 'Bearer secret' });
  assert.equal(options.fetch, request);
});

test('queries loaded models and reuses tags metadata through the diagnostics client', async () => {
  const calls = [];
  const inspection = await inspectOllamaModels({
    async list() {
      calls.push('list');
      return {
        models: [{ name: 'gemma3:latest', details: { context_length: 131072 } }]
      };
    },
    async ps() {
      calls.push('ps');
      return {
        models: [{ name: 'gemma3:latest', context_length: 32768 }]
      };
    },
    async show() {
      assert.fail('tag metadata should avoid an additional lookup');
    }
  });

  assert.deepEqual(calls, ['list', 'ps']);
  assert.deepEqual(inspection.availableModels, ['gemma3:latest']);
  assert.deepEqual(inspection.loadedModelLines, [
    'Ollama reports 1 loaded local model(s):',
    '- gemma3:latest: runtime context allocation: 32K; maximum supported context: 128K; WARNING: runtime allocation is below the recommended 64K'
  ]);
});

test('reports a manual context cap without recommending allocations beyond it or native capacity', async () => {
  const inspection = await inspectOllamaModels({
    async list() {
      return { models: [
        { name: 'capped', context_length: 131072 },
        { name: 'underallocated', context_length: 131072 },
        { name: 'small-native', max_context_length: 131072, model_info: { 'llama.context_length': 8192 } }
      ] };
    },
    async ps() {
      return { models: [
        { name: 'capped', context_length: 32768 },
        { name: 'underallocated', context_length: 4096 },
        { name: 'small-native', context_length: 8192 }
      ] };
    },
    async show() {
      assert.fail('tag metadata should avoid an additional lookup');
    }
  }, 32768);

  assert.deepEqual(inspection.loadedModelLines, [
    'Ollama reports 3 loaded local model(s):',
    '- capped: runtime context allocation: 32K; maximum supported context: 128K; configured context cap: 32K',
    '- underallocated: runtime context allocation: 4K; maximum supported context: 128K; configured context cap: 32K; WARNING: runtime allocation is below the recommended 32K',
    '- small-native: runtime context allocation: 8K; maximum supported context: 8K; configured context cap: 32K'
  ]);
});

test('keeps available model diagnostics when the loaded-model request fails', async () => {
  const psError = new Error('ps unavailable');
  const inspection = await inspectOllamaModels({
    async list() {
      return { models: [{ name: 'gemma3:latest' }] };
    },
    async ps() {
      throw psError;
    },
    async show() {
      assert.fail('a failed process lookup should not request model metadata');
    }
  });

  assert.deepEqual(inspection.availableModels, ['gemma3:latest']);
  assert.equal(inspection.loadedModelLines, undefined);
  assert.equal(inspection.loadedModelsError, psError);
});

test('uses show metadata when tags fail but loaded models are available', async () => {
  const listError = new Error('tags unavailable');
  let shownModel;
  const inspection = await inspectOllamaModels({
    async list() {
      throw listError;
    },
    async ps() {
      return {
        models: [{ model: 'qwen3.5:latest', context_length: 65536 }]
      };
    },
    async show({ model }) {
      shownModel = model;
      return { model_info: { 'qwen3.context_length': 262144 } };
    }
  });

  assert.equal(inspection.availableModels, undefined);
  assert.equal(inspection.availableModelsError, listError);
  assert.equal(shownModel, 'qwen3.5:latest');
  assert.deepEqual(inspection.loadedModelLines, [
    'Ollama reports 1 loaded local model(s):',
    '- qwen3.5:latest: runtime context allocation: 64K; maximum supported context: 256K'
  ]);
});

test('flags a loaded model whose runtime context allocation is below 64K', async () => {
  const lines = await loadedModelContextDiagnosticLines([
    { name: 'gemma3:latest', context_length: 32768 }
  ], [
    { name: 'gemma3:latest', details: { context_length: 131072 } }
  ], async () => {
    assert.fail('tag metadata should avoid an additional lookup');
  });

  assert.deepEqual(lines, [
    'Ollama reports 1 loaded local model(s):',
    '- gemma3:latest: runtime context allocation: 32K; maximum supported context: 128K; WARNING: runtime allocation is below the recommended 64K'
  ]);
});

test('reports a sufficient loaded runtime context allocation without a warning', async () => {
  const lines = await loadedModelContextDiagnosticLines([
    {
      model: 'qwen3.5:latest',
      context_length: 65536
    }
  ], [], async model => {
    assert.equal(model, 'qwen3.5:latest');
    return { max_context_length: 262144 };
  });

  assert.deepEqual(lines, [
    'Ollama reports 1 loaded local model(s):',
    '- qwen3.5:latest: runtime context allocation: 64K; maximum supported context: 256K'
  ]);
});

test('explains how to populate diagnostics when no local model is loaded', async () => {
  const lines = await loadedModelContextDiagnosticLines([], [], async () => {
    assert.fail('an empty process list should not request model metadata');
  });

  assert.deepEqual(lines, [
    'No local models are currently loaded. Send a prompt to a local Ollama model, then rerun `Ollama: Diagnose Models`.'
  ]);
});

test('reads maximum context only from model metadata supplied separately from the runtime process', () => {
  assert.equal(maximumSupportedContextLength({ context_length: 131072 }), 131072);
  assert.equal(maximumSupportedContextLength({
    model_info: { 'gemma3.context_length': 131072 }
  }), 131072);
});

test('formats thinking diagnostics with server-advertised default and effective setting for next request', () => {
  const models = [{
    model: 'server/qwen3.8:27b',
    thinkingPolicy: { levels: [false, 'low', 'medium', 'xhigh'], defaultLevel: 'medium' },
    defaultSource: 'server'
  }];
  const lines = thinkingDiagnosticLines(models, { 'server/qwen3.8:27b': 'low' });

  assert.deepEqual(lines, [
    'Thinking settings:',
    '- server/qwen3.8:27b: supported values: [false, "low", "medium", "xhigh"]; server-advertised default: "medium"; configured override: "low"; effective setting for next request: "low"'
  ]);
});

test('distinguishes compatibility fallback defaults and explains omitted think when override is unset', () => {
  const models = [{
    model: 'gpt-oss:20b',
    thinkingPolicy: { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
    defaultSource: 'compatibility'
  }];
  const lines = thinkingDiagnosticLines(models, {});

  assert.deepEqual(lines, [
    'Thinking settings:',
    '- gpt-oss:20b: supported values: ["low", "medium", "high"]; compatibility fallback default: "medium"; configured override: none; think will be omitted to use server default'
  ]);
});

test('explains why an unsupported override is ignored and that think will be omitted', () => {
  const models = [{
    model: 'deepseek-v4-flash:cloud',
    thinkingPolicy: { levels: [false, 'high', 'max'], defaultLevel: false },
    defaultSource: 'compatibility'
  }];
  const lines = thinkingDiagnosticLines(models, { 'deepseek-v4-flash:cloud': 'low' });

  assert.deepEqual(lines, [
    'Thinking settings:',
    '- deepseek-v4-flash:cloud: supported values: [false, "high", "max"]; compatibility fallback default: false; configured override: "low" (unsupported, ignored); think will be omitted to use server default'
  ]);
});

test('supports boolean configured thinking overrides', () => {
  const models = [{
    model: 'deepseek-v4-flash:cloud',
    thinkingPolicy: { levels: [false, 'high', 'max'], defaultLevel: false },
    defaultSource: 'compatibility'
  }];
  const lines = thinkingDiagnosticLines(models, { 'deepseek-v4-flash:cloud': false });

  assert.deepEqual(lines, [
    'Thinking settings:',
    '- deepseek-v4-flash:cloud: supported values: [false, "high", "max"]; compatibility fallback default: false; configured override: false; effective setting for next request: false'
  ]);
});

test('explains unavailable overrides without inferring that a model cannot think', () => {
  const nonThinking = [{ model: 'llama3:8b' }];
  assert.deepEqual(thinkingDiagnosticLines([], {}), []);
  assert.deepEqual(thinkingDiagnosticLines(nonThinking, {}), [
    'Thinking settings:',
    '- llama3:8b: configurable thinking values unavailable; configured override: none; think will be omitted to use server default'
  ]);

  const linesWithOverride = thinkingDiagnosticLines(nonThinking, { 'llama3:8b': 'high' });
  assert.deepEqual(linesWithOverride, [
    'Thinking settings:',
    '- llama3:8b: configurable thinking values unavailable; configured override: "high" (ignored); think will be omitted to use server default'
  ]);
});

test('handles malformed thinking levels gracefully', () => {
  const models = [{
    model: 'gpt-oss:20b',
    thinkingPolicy: { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
    defaultSource: 'compatibility'
  }];
  for (const malformed of [null, undefined, false, 'invalid', [1, 2]]) {
    const lines = thinkingDiagnosticLines(models, malformed);
    assert.deepEqual(lines, [
      'Thinking settings:',
      '- gpt-oss:20b: supported values: ["low", "medium", "high"]; compatibility fallback default: "medium"; configured override: none; think will be omitted to use server default'
    ]);
  }
});

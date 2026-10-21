const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class Disposable {
  dispose() {}
}

class EventEmitter {
  event = () => new Disposable();
  fire() {}
  dispose() {}
}

class CancellationTokenSource {
  token = cancellationToken;
  cancel() {}
  dispose() {}
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

class LanguageModelToolCallPart {}
class LanguageModelToolResultPart {}

const cancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => new Disposable()
};

const vscode = {
  CancellationError: class CancellationError extends Error {},
  CancellationTokenSource,
  EventEmitter,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => undefined },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback })
  }
};

let models = [];
let chatRequests = [];
let settings = {};

class Ollama {
  async version() {
    return { version: 'test' };
  }

  async list() {
    return { models };
  }

  async show({ model }) {
    return models.find(candidate => (candidate.model || candidate.name) === model)?.show ?? {};
  }

  async chat(request) {
    chatRequests.push(request);
    return {
      abort() {},
      async *[Symbol.asyncIterator]() {
        yield { done: true, message: {} };
      }
    };
  }
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  if (request === 'ollama') {
    return { Ollama };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let OllamaLanguageModelProvider;
try {
  ({ OllamaLanguageModelProvider } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test.beforeEach(() => {
  models = [];
  chatRequests = [];
  settings = {};
});

test('leaves the server default unchanged when no effort setting is present', async () => {
  models = [{ name: 'deepseek-v4-flash:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    {},
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test('omits a stale thinking value from the actual Ollama request', async () => {
  models = [{ name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
  settings.thinkingLevels = { 'gpt-oss:20b': 'none' };

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    {},
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test('accepts thinking settings only with both a verified policy and server capability', async () => {
  models = [
    { name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' },
    { name: 'gpt-oss:120b', capabilities: ['tools'], remote_host: 'ollama.com' },
    { name: 'unknown-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }
  ];
  const provider = new OllamaLanguageModelProvider();
  const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
  const policies = Object.fromEntries(discovered.map(model => [
    model.id,
    model.thinkingPolicy
  ]));

  assert.deepEqual(policies['gpt-oss:20b'].levels, ['low', 'medium', 'high']);
  assert.equal(policies['gpt-oss:120b'], undefined);
  assert.equal(policies['unknown-thinking:cloud'], undefined);
  for (const model of discovered.slice(1)) {
    settings.thinkingLevels = { [model.model]: 'high' };
    await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, undefined);
  }
});

test('sends each supported setting unchanged and reads edits on the next request', async () => {
  for (const { name, values, default: defaultLevel } of [
    { name: 'qwen3.8:27b-mlx', values: [false, 'low', 'medium', 'xhigh'], default: 'medium' },
    { name: 'glm-5.2:cloud', values: [false, 'high', 'max'], default: 'high' },
    { name: 'qwen3.6:27b', values: [false, true], default: true },
    { name: 'custom-thinking:cloud', values: ['brief', 'deep'], default: 'brief' }
  ]) {
    models = [{ name, model: `server/${name}`, capabilities: ['thinking'], remote_host: 'ollama.com',
      max_context_length: 131072,
      show: { thinking: { values, default: defaultLevel } } }];
    const provider = new OllamaLanguageModelProvider();
    try {
      const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
      assert.deepEqual(model.thinkingPolicy.levels, values);
      for (const value of [...values, undefined, 'stale', 1, null, {}]) {
        settings.thinkingLevels = { [model.model]: value };
        await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
        assert.equal(chatRequests.at(-1).model, `server/${name}`);
        assert.equal(chatRequests.at(-1).think,
          values.includes(value) ? value : undefined);
      }
    } finally {
      provider.dispose();
    }
  }
});

test('refreshing metadata rejects a previously supported saved value', async () => {
  const entry = { name: 'gpt-oss:120b-cloud', capabilities: ['thinking'], remote_host: 'ollama.com',
    show: { thinking: { values: ['low', 'medium', 'high'], default: 'medium' } } };
  models = [entry];
  const provider = new OllamaLanguageModelProvider();
  try {
    await provider.provideLanguageModelChatInformation({}, cancellationToken);
    entry.show.thinking = { values: [false], default: false };
    provider.refresh();
    const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    assert.equal(model.thinkingPolicy, undefined);
    settings.thinkingLevels = { [model.model]: 'high' };
    await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, undefined);
  } finally {
    provider.dispose();
  }
});

test('uses exact server model identifiers and keeps settings separate for each model', async () => {
  models = [
    { name: 'Display name', model: 'server/qwen3.8:27b', capabilities: ['thinking'], remote_host: 'ollama.com',
      show: { thinking: { values: [false, 'low', 'xhigh'], default: 'low' } } },
    { name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }
  ];
  const provider = new OllamaLanguageModelProvider();
  try {
    const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    settings.thinkingLevels = { 'Display name': 'xhigh', 'gpt-oss:20b': 'high' };
    for (const model of discovered) {
      await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    }
    assert.deepEqual(chatRequests.map(request => request.think), [undefined, 'high']);
    settings.thinkingLevels['server/qwen3.8:27b'] = false;
    await provider.provideLanguageModelChatResponse(discovered[0], [], {}, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, false);
    delete settings.thinkingLevels['server/qwen3.8:27b'];
    await provider.provideLanguageModelChatResponse(discovered[0], [], {}, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).think, undefined);
  } finally {
    provider.dispose();
  }
});

test('ignores malformed maps and inherited effort entries', async () => {
  models = [{ name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  try {
    const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    for (const value of [null, false, 'high', ['high'], Object.create({ 'gpt-oss:20b': 'high' })]) {
      settings.thinkingLevels = value;
      await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
      assert.equal(chatRequests.at(-1).think, undefined);
    }
  } finally {
    provider.dispose();
  }
});

test('matches older-server fallback policies using the request identifier instead of a display name', async () => {
  models = [{ name: 'Friendly GPT', model: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  settings.thinkingLevels = { 'gpt-oss:20b': 'high' };
  const provider = new OllamaLanguageModelProvider();
  try {
    const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    assert.equal(chatRequests.at(-1).model, 'gpt-oss:20b');
    assert.equal(chatRequests.at(-1).think, 'high');
  } finally {
    provider.dispose();
  }
});

test('provides thinking diagnostics through provider agreeing with request configuration', async () => {
  models = [
    {
      name: 'Qwen Display',
      model: 'server/qwen3.8:27b',
      capabilities: ['thinking'],
      remote_host: 'ollama.com',
      show: { thinking: { values: [false, 'low', 'medium'], default: 'medium' } }
    },
    {
      name: 'gpt-oss:20b',
      capabilities: ['thinking'],
      remote_host: 'ollama.com'
    }
  ];
  settings.thinkingLevels = { 'server/qwen3.8:27b': 'low' };
  const provider = new OllamaLanguageModelProvider();
  try {
    const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    const lines = provider.getThinkingDiagnosticLines(settings.thinkingLevels);
    assert.deepEqual(lines, [
      'Thinking settings for http://127.0.0.1:11434/:',
      '- server/qwen3.8:27b: supported values: [false, "low", "medium"]; server-advertised default: "medium"; configured override: "low"; effective setting for next request: "low"',
      '- gpt-oss:20b: supported values: ["low", "medium", "high"]; compatibility fallback default: "medium"; configured override: none; think will be omitted to use server default'
    ]);
    for (const model of discovered) {
      await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    }
    assert.deepEqual(chatRequests.map(request => request.think), ['low', undefined]);
  } finally {
    provider.dispose();
  }
});

test('keeps provider groups separate and drops removed groups from a new diagnostic snapshot', async () => {
  const first = { configuration: { url: 'http://127.0.0.1:9/first' } };
  const second = { configuration: {
    url: 'http://diagnostic-user:diagnostic-password@127.0.0.1:9/second?token=diagnostic-token',
    headers: { Authorization: 'Bearer diagnostic-header' }
  } };
  const entry = {
    name: 'Shared model', model: 'shared:latest', capabilities: ['thinking'], remote_host: 'ollama.com'
  };
  settings.thinkingLevels = { 'shared:latest': false };
  const provider = new OllamaLanguageModelProvider();
  try {
    models = [{ ...entry, show: { thinking: { values: [false, true], default: true } } }];
    const [booleanModel] = await provider.provideLanguageModelChatInformation(first, cancellationToken);
    models = [{ ...entry, show: { thinking: { values: ['low', 'high'], default: 'low' } } }];
    const [namedModel] = await provider.provideLanguageModelChatInformation(second, cancellationToken);
    const lines = provider.getThinkingDiagnosticLines(settings.thinkingLevels);
    assert.deepEqual(lines, [
      'Thinking settings for http://127.0.0.1:9/first:',
      '- shared:latest: supported values: [false, true]; server-advertised default: true; configured override: false; effective setting for next request: false',
      'Thinking settings for http://127.0.0.1:9/second:',
      '- shared:latest: supported values: ["low", "high"]; server-advertised default: "low"; configured override: false (unsupported, ignored); think will be omitted to use server default'
    ]);
    assert.doesNotMatch(lines.join('\n'), /diagnostic-(user|password|token|header)/);
    for (const model of [booleanModel, namedModel, booleanModel]) {
      await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
    }
    assert.deepEqual(chatRequests.map(request => request.think), [false, undefined, false]);

    provider.resetThinkingDiagnostics();
    assert.deepEqual(provider.getThinkingDiagnosticLines(settings.thinkingLevels), []);
    models = [{ ...entry, show: { thinking: { values: [false, true], default: true } } }];
    await provider.provideLanguageModelChatInformation(first, cancellationToken);
    assert.deepEqual(provider.getThinkingDiagnosticLines(settings.thinkingLevels), lines.slice(0, 2));
  } finally {
    provider.dispose();
  }
});

test('keeps models with missing or non-configurable metadata visible while omitting think', async () => {
  models = [
    { name: 'unknown-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' },
    { name: 'always-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com',
      show: { thinking: { values: [true], default: true } } },
    { name: 'invalid-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com',
      show: { thinking: { values: ['low', 'high'] } } }
  ];
  const provider = new OllamaLanguageModelProvider();
  try {
    const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
    for (const configuredValue of [undefined, true]) {
      settings.thinkingLevels = configuredValue === undefined ? {}
        : Object.fromEntries(models.map(model => [model.name, configuredValue]));
      const lines = provider.getThinkingDiagnosticLines(settings.thinkingLevels);
      for (const model of discovered) {
        const line = lines.find(line => line.startsWith(`- ${model.model}:`));
        assert.ok(line, `${model.model} must remain visible without an override`);
        assert.match(line, /configurable thinking values unavailable/);
        assert.match(line, /think will be omitted to use server default/);
        assert.doesNotMatch(line, /does not support thinking/);
        assert.match(line, configuredValue === undefined ? /configured override: none/ : /configured override: true \(ignored\)/);
        await provider.provideLanguageModelChatResponse(model, [], {}, { report() {} }, cancellationToken);
        assert.equal(chatRequests.at(-1).think, undefined);
      }
    }
  } finally {
    provider.dispose();
  }
});

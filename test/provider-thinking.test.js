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

class LanguageModelThinkingPart extends LanguageModelTextPart {}
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
  LanguageModelThinkingPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  commands: { executeCommand: async () => undefined },
  env: { openExternal: async () => undefined },
  window: {
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  }
};

let models = [];
let chatRequests = [];

class Ollama {
  async version() {
    return { version: 'test' };
  }

  async list() {
    return { models };
  }

  async show({ model }) {
    return models.find(candidate => candidate.name === model)?.show ?? {};
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
});

test('sends the policy default when VS Code omits an unset model configuration', async () => {
  models = [{ name: 'deepseek-v4-flash:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    { modelConfiguration: {} },
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, false);
});

test('omits a stale thinking value from the actual Ollama request', async () => {
  models = [{ name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' }];
  const provider = new OllamaLanguageModelProvider();
  const [model] = await provider.provideLanguageModelChatInformation({}, cancellationToken);

  await provider.provideLanguageModelChatResponse(
    model,
    [{ role: 1, content: [new LanguageModelTextPart('hello')] }],
    { modelConfiguration: { thinkingLevel: 'none' } },
    { report() {} },
    cancellationToken
  );

  assert.equal(chatRequests.length, 1);
  assert.equal(chatRequests[0].think, undefined);
});

test('exposes thinking controls only with both a verified policy and server capability', async () => {
  models = [
    { name: 'gpt-oss:20b', capabilities: ['thinking'], remote_host: 'ollama.com' },
    { name: 'gpt-oss:120b', capabilities: ['tools'], remote_host: 'ollama.com' },
    { name: 'unknown-thinking:cloud', capabilities: ['thinking'], remote_host: 'ollama.com' }
  ];
  const provider = new OllamaLanguageModelProvider();
  const discovered = await provider.provideLanguageModelChatInformation({}, cancellationToken);
  const properties = Object.fromEntries(discovered.map(model => [
    model.id,
    model.configurationSchema.properties
  ]));

  assert.deepEqual(properties['gpt-oss:20b'].thinkingLevel.enum, ['low', 'medium', 'high']);
  assert.equal(properties['gpt-oss:120b'].thinkingLevel, undefined);
  assert.equal(properties['unknown-thinking:cloud'].thinkingLevel, undefined);
});

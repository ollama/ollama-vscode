const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

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

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {}
  dispose() {}
}

const vscode = {
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  EventEmitter,
  CancellationTokenSource: cancellationTokenSource,
  window: { showWarningMessage: async () => undefined },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  }
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let OllamaLanguageModelProvider;
try {
  ({ OllamaLanguageModelProvider } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

for (const { name, options = {}, extraParts = [] } of [
  {
    name: 'tool definitions',
    options: { tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object' } }] }
  },
  { name: 'tool calls', extraParts: [new LanguageModelToolCallPart('call-1', 'lookup', { q: 'x' })] },
  { name: 'tool results', extraParts: [new LanguageModelToolResultPart('call-1', [new LanguageModelTextPart('result')])] },
  { name: 'images', extraParts: [new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')] }
]) {
  test(`token calibration ignores prompt overhead from ${name}`, async () => {
    let promptTokens = 1000;
    await withServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(JSON.stringify({ message: { content: 'Hello' }, done: true, prompt_eval_count: promptTokens, eval_count: 7 }) + '\n');
    }, async url => {
      const provider = new OllamaLanguageModelProvider();
      const model = { id: 'test-model:latest', name: 'test-model:latest', model: 'test-model:latest', url, headers: {}, local: false };
      const token = cancellationTokenSource().token;
      const text = 'x'.repeat(100);
      const message = { role: vscode.LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart(text)] };
      const augmented = { ...message, content: [...message.content, ...extraParts] };
      const progress = collectProgress();
      try {
        assert.equal(await provider.provideTokenCount(model, text, token), 25);
        await provider.provideLanguageModelChatResponse(model, [augmented], options, progress, token);
        assert.equal(await provider.provideTokenCount(model, text, token), 25);
        const usage = progress.reports.find(part => part instanceof LanguageModelDataPart);
        assert.deepEqual(JSON.parse(new TextDecoder().decode(usage.data)), {
          prompt_tokens: 1000, completion_tokens: 7, total_tokens: 1007
        });

        // A text-only prompt still calibrates the model; later tool/image prompts
        // must preserve that learned ratio rather than resetting or inflating it.
        promptTokens = 50;
        await provider.provideLanguageModelChatResponse(model, [message], {}, collectProgress(), token);
        assert.equal(await provider.provideTokenCount(model, text, token), 34);
        promptTokens = 1000;
        await provider.provideLanguageModelChatResponse(model, [augmented], options, collectProgress(), token);
        assert.equal(await provider.provideTokenCount(model, text, token), 34);
      } finally {
        provider.dispose();
      }
    });
  });
}

test('token calibration accepts text data parts and low character-per-token ratios', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(JSON.stringify({ message: { content: 'Hello' }, done: true, prompt_eval_count: 100 }) + '\n');
  }, async url => {
    const provider = new OllamaLanguageModelProvider();
    const model = { id: 'test-model:latest', name: 'test-model:latest', model: 'test-model:latest', url, headers: {}, local: false };
    const token = cancellationTokenSource().token;
    const text = '你'.repeat(100);
    try {
      await provider.provideLanguageModelChatResponse(model, [{
        role: vscode.LanguageModelChatMessageRole.User,
        content: [new LanguageModelDataPart(new TextEncoder().encode(text), 'text/plain')]
      }], { tools: [] }, collectProgress(), token);
      assert.equal(await provider.provideTokenCount(model, text, token), 40);
      assert.equal(await provider.provideTokenCount({ ...model, id: 'other-model' }, text, token), 25);
    } finally {
      provider.dispose();
    }
  });
});

test('recovers a stream that ends with done_reason but no done marker', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ message: { content: 'Hello' }, prompt_eval_count: 5 })}\n`);
    response.write(`${JSON.stringify({
      message: {
        content: ' world',
        tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: { q: 'x' } } }]
      }
    })}\n`);
    response.end(`${JSON.stringify({ done_reason: 'stop', eval_count: 7 })}\n`);
  }, async url => {
    const progress = collectProgress();
    await runChatResponse(url, progress);

    const text = progress.reports
      .filter(part => part instanceof LanguageModelTextPart)
      .map(part => part.value)
      .join('');
    assert.equal(text, 'Hello world');

    const toolCall = progress.reports.find(part => part instanceof LanguageModelToolCallPart);
    assert.equal(toolCall.callId, 'call-1');
    assert.equal(toolCall.name, 'lookup');
    assert.deepEqual(toolCall.input, { q: 'x' });

    const usage = progress.reports.find(part => part instanceof LanguageModelDataPart);
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(usage.data)),
      { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }
    );
  });
});

test('rejects when the stream ends without any completion signal', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(`${JSON.stringify({ message: { content: 'partial' } })}\n`);
  }, async url => {
    await assert.rejects(
      runChatResponse(url, collectProgress()),
      error => error.message === 'Did not receive done or success response in stream.'
    );
  });
});

test('still rejects an unrelated stream error received after a done_reason chunk', async () => {
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ done_reason: 'stop', eval_count: 7 })}\n`);
    response.end(`${JSON.stringify({ error: 'boom' })}\n`);
  }, async url => {
    await assert.rejects(
      runChatResponse(url, collectProgress()),
      error => error.message === 'boom'
    );
  });
});

for (const [name, inputSchema] of [['omitted', undefined], ['empty', {}]]) {
  test(`sends an object schema for a tool with ${name} input schema`, async () => {
    let sent;
    await withServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      sent = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({
        message: { tool_calls: [{ id: 'time-1', function: { name: 'get_time', arguments: {} } }] },
        done: true
      })}\n`);
    }, async url => {
      const progress = collectProgress();
      await runChatResponse(url, progress, {
        tools: [{ name: 'get_time', description: 'Get the current time.', inputSchema }]
      });
      assert.deepEqual(sent.tools, [{
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Get the current time.',
          parameters: { type: 'object', properties: {} }
        }
      }]);
      const call = progress.reports.find(part => part instanceof LanguageModelToolCallPart);
      assert.equal(call.name, 'get_time');
      assert.deepEqual(call.input, {});
    });
  });
}

test('preserves and surfaces an unsupported tool schema without retrying', async () => {
  const inputSchema = { type: '', properties: null };
  const detail = 'Unable to generate parser for this template. Unrecognized schema: {"type":"","properties":null}';
  let attempts = 0;
  let sent;
  await withServer(async (request, response) => {
    attempts++;
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    sent = JSON.parse(body);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: detail }));
  }, async url => {
    const progress = collectProgress();
    await assert.rejects(runChatResponse(url, progress, {
      tools: [{ name: 'get_time', description: 'Get the current time.', inputSchema }]
    }), error => error.status === 400 && error.message.includes(detail));
    assert.deepEqual(sent.tools[0].function.parameters, inputSchema);
    assert.equal(attempts, 1);
    assert.deepEqual(progress.reports, []);
  });
});

test('uses the server model identifier for metadata and chat while preserving the display name', async () => {
  const tags = [{ name: 'qwen3.8:27b', model: '5090.qwen3.8:27b' }];
  await withModelServer(tags, ['5090.qwen3.8:27b'], async (url, requests) => {
    const [model] = await discoverModels(url);
    const progress = collectProgress();
    await runChatResponse(url, progress, {}, model);

    assert.equal(model.name, 'qwen3.8:27b');
    assert.equal(model.id, '5090.qwen3.8:27b');
    assert.deepEqual(model.capabilities, { toolCalling: true, imageInput: true });
    assert.equal(model.maxInputTokens, 131072 - 4096);
    assert.deepEqual(requests, [
      { path: '/api/show', model: '5090.qwen3.8:27b' },
      { path: '/api/chat', model: '5090.qwen3.8:27b' }
    ]);
    assert.equal(progress.reports[0].value, 'Hello');
  });
});

test('keeps ordinary model names and falls back when the model identifier is missing or invalid', async () => {
  const identifiers = ['qwen3.8:27b', 'missing:latest', 'empty:latest', 'null:latest', 'invalid:latest'];
  const tags = [
    { name: identifiers[0], model: identifiers[0] },
    { name: identifiers[1] },
    { name: identifiers[2], model: '' },
    { name: identifiers[3], model: null },
    { name: identifiers[4], model: 42 }
  ];
  await withModelServer(tags, identifiers, async (url, requests) => {
    const models = await discoverModels(url);
    assert.deepEqual(models.map(model => model.id), identifiers);
    for (const model of models) {
      await runChatResponse(url, collectProgress(), {}, model);
    }
    assert.deepEqual(requests.filter(request => request.path === '/api/chat').map(request => request.model), identifiers);
  });
});

test('preserves older-model guidance when a server prefixes its identifier', async () => {
  const warnings = [];
  const originalWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (message, ...actions) => {
    warnings.push({ message, actions });
    return 'Continue anyway';
  };
  try {
    for (const id of ['qwen2.5-coder:7b', '5090.qwen2.5-coder:7b']) {
      warnings.length = 0;
      await withModelServer([{ name: 'qwen2.5-coder:7b', model: id }], [id], async url => {
        const [model] = await discoverModels(url);
        await runChatResponse(url, collectProgress(), {}, model);
        assert.equal(warnings.length, 1);
        assert(warnings[0].message.startsWith('qwen2.5-coder:7b may not work as reliably'));
        assert(warnings[0].actions.includes('Continue anyway'));
      });
    }
  } finally {
    vscode.window.showWarningMessage = originalWarning;
  }
});

test('recognizes cloud identifiers behind display names and preserves name-only cloud models', async () => {
  const tags = [
    { name: 'Cloud model', model: 'qwen3.8:cloud' },
    { name: 'qwen3.8:27b-cloud' }
  ];
  const identifiers = ['qwen3.8:cloud', 'qwen3.8:27b-cloud'];
  await withModelServer(tags, identifiers, async url => {
    const models = await discoverModels(url);
    for (const model of models) {
      assert.equal(model.local, false);
      await runChatResponse(url, collectProgress(), {}, model);
    }
  });
});

test('accepts configured identifiers and display names, including models absent from tags', async () => {
  const tags = [{ name: 'qwen3.8:27b', model: '5090.qwen3.8:27b' }];
  await withModelServer(tags, ['5090.qwen3.8:27b', 'custom:latest'], async url => {
    for (const configured of ['5090.qwen3.8:27b', 'qwen3.8:27b']) {
      const [model] = await discoverModels(url, [configured]);
      assert.equal(model.name, 'qwen3.8:27b');
      assert.equal(model.id, '5090.qwen3.8:27b');
      assert.equal(model.capabilities.toolCalling, true);
      await runChatResponse(url, collectProgress(), {}, model);
    }
    const [custom] = await discoverModels(url, ['custom:latest']);
    assert.equal(custom.id, 'custom:latest');
    await runChatResponse(url, collectProgress(), {}, custom);
  });
});

test('distinguishes matching display names and prefers an exact configured identifier', async () => {
  const tags = [
    { name: 'qwen3.8:27b', model: '5090.qwen3.8:27b' },
    { name: 'qwen3.8:27b', model: '4090.qwen3.8:27b' },
    { name: '5090.qwen3.8:27b', model: 'other.qwen3.8:27b' }
  ];
  const identifiers = tags.map(model => model.model);
  await withModelServer(tags, identifiers, async url => {
    const models = await discoverModels(url);
    assert.deepEqual(models.map(model => model.name), tags.map(model => model.name));
    assert.deepEqual(models.map(model => model.id), identifiers);
    const [selected] = await discoverModels(url, ['5090.qwen3.8:27b']);
    assert.equal(selected.name, 'qwen3.8:27b');
    assert.equal(selected.id, '5090.qwen3.8:27b');
    await runChatResponse(url, collectProgress(), {}, selected);
  });
});

async function discoverModels(url, models = []) {
  const provider = new OllamaLanguageModelProvider();
  try {
    return await provider.provideLanguageModelChatInformation(
      { configuration: { url, models } },
      cancellationTokenSource().token
    );
  } finally {
    provider.dispose();
  }
}

async function withModelServer(models, identifiers, run) {
  const requests = [];
  await withServer(async (request, response) => {
    let result;
    switch (request.url) {
      case '/api/version':
        result = { version: '0.34.4' };
        break;
      case '/api/tags':
        result = { models };
        break;
      case '/api/experimental/model-recommendations':
        result = { recommendations: [] };
        break;
      case '/api/ps':
        result = { models: identifiers.map(model => ({ model, context_length: 65536 })) };
        break;
      case '/api/show':
      case '/api/chat': {
        let body = '';
        for await (const chunk of request) {
          body += chunk;
        }
        const { model } = JSON.parse(body);
        requests.push({ path: request.url, model });
        if (!identifiers.includes(model)) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'Model not found' }));
          return;
        }
        result = request.url === '/api/show'
          ? { capabilities: ['tools', 'vision'], model_info: { context_length: 131072 } }
          : { message: { content: 'Hello' }, done: true };
        break;
      }
      default:
        response.writeHead(404);
        response.end();
        return;
    }
    request.resume();
    response.writeHead(200, {
      'content-type': request.url === '/api/chat' ? 'application/x-ndjson' : 'application/json'
    });
    response.end(JSON.stringify(result) + '\n');
  }, url => run(url, requests));
}

function collectProgress() {
  return {
    reports: [],
    report(part) {
      this.reports.push(part);
    }
  };
}

async function runChatResponse(url, progress, options = {}, discoveredModel) {
  const provider = new OllamaLanguageModelProvider();
  const model = discoveredModel ?? {
    id: 'test-model:latest',
    name: 'test-model:latest',
    family: 'test-model',
    model: 'test-model:latest',
    url,
    headers: {},
    local: false
  };
  const messages = [{
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new LanguageModelTextPart('Hi')]
  }];
  const token = cancellationTokenSource().token;

  return provider.provideLanguageModelChatResponse(model, messages, options, progress, token);
}

function cancellationTokenSource() {
  const listeners = new Set();
  let cancelled = false;

  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    },
    dispose() {
      listeners.clear();
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) {
        listener();
      }
    }
  };
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');
const { Ollama } = require('ollama');

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

class CancellationError extends Error {
  constructor(message = 'Canceled') {
    super(message);
    this.name = 'CancellationError';
  }
}

const vscode = {
  CancellationError,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  EventEmitter,
  CancellationTokenSource: cancellationTokenSource,
  window: { showWarningMessage: async () => undefined },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => key in settings ? settings[key] : fallback })
  }
};

let settings = {};
test.beforeEach(() => { settings = {}; });

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

test('counts adjacent text fragments while separating text data parts', async () => {
  const provider = new OllamaLanguageModelProvider();
  try {
    const model = { id: 'test-model' };
    const token = cancellationTokenSource().token;
    const message = {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelTextPart('abcd'), new LanguageModelTextPart('efgh')]
    };
    assert.equal(await provider.provideTokenCount(model, message, token), 2);
    const mixed = {
      ...message,
      content: [
        new LanguageModelTextPart('abcd'),
        new LanguageModelDataPart(new TextEncoder().encode('efgh'), 'text/plain')
      ]
    };
    assert.equal(await provider.provideTokenCount(model, mixed, token), 3);
    assert.equal(await provider.provideTokenCount(model, structuredClone(message), token), 2);
    assert.equal(await provider.provideTokenCount(model, structuredClone(mixed), token), 3);
  } finally {
    provider.dispose();
  }
});

test('preserves streamed fragments in structural history and calibrates against the joined text', async () => {
  const requests = [];
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(JSON.stringify({ message: { content: 'Hel' } }) + '\n');
    response.end(JSON.stringify({ message: { content: 'lo' }, done: true, prompt_eval_count: 4 }) + '\n');
  }, async url => {
    const provider = new OllamaLanguageModelProvider();
    const model = { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false };
    const token = cancellationTokenSource().token;
    const user = { role: 1, content: [{ value: 'abcd' }, { value: 'efgh' }] };
    const progress = collectProgress();
    try {
      await provider.provideLanguageModelChatResponse(model, [user], {}, progress, token);
      assert.equal(requests[0].messages[0].content, 'abcdefgh');
      assert.equal(await provider.provideTokenCount(model, 'x'.repeat(100), token), 34);
      const fragments = progress.reports.filter(part => part instanceof LanguageModelTextPart);
      assert.deepEqual(fragments.map(part => part.value), ['Hel', 'lo']);
      const history = [
        user,
        { role: 2, content: structuredClone(fragments) },
        { role: 1, content: [{ value: 'next' }] }
      ];
      await provider.provideLanguageModelChatResponse(model, history, {}, collectProgress(), token);
      assert.deepEqual(requests[1].messages, [
        { role: 'user', content: 'abcdefgh' },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'next' }
      ]);
    } finally {
      provider.dispose();
    }
  });
});

for (const { name, options = {}, extraParts = [] } of [
  {
    name: 'tool definitions',
    options: { tools: [{ name: 'lookup', description: 'Look up a value', inputSchema: { type: 'object' } }] }
  },
  { name: 'tool calls', extraParts: [new LanguageModelToolCallPart('call-1', 'lookup', { q: 'x' })] },
  { name: 'tool results', extraParts: [new LanguageModelToolResultPart('call-1', [new LanguageModelTextPart('result')])] },
  { name: 'images', extraParts: [new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')] },
  { name: 'thinking parts', extraParts: [{ value: 'thinking', id: undefined, metadata: undefined }] },
  { name: 'serialized text data', extraParts: [{ mimeType: 'text/plain', data: 'aGVsbG8=' }] }
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

test('counts structural text and byte data without decoding serialized data or thinking', async () => {
  const provider = new OllamaLanguageModelProvider();
  const model = { id: 'test-model' };
  const token = cancellationTokenSource().token;
  const text = 'x'.repeat(100);
  try {
    for (const part of [{ value: text }, { mimeType: 'text/plain', data: new TextEncoder().encode(text) }]) {
      assert.equal(await provider.provideTokenCount(model, { role: 1, content: [part] }, token), 25);
    }
    for (const part of [
      { value: text, id: undefined, metadata: undefined },
      { $mid: 999, value: text },
      { mimeType: 'text/plain', data: Buffer.from(text).toString('base64') },
      new LanguageModelDataPart(Buffer.from(text).toString('base64'), 'text/plain')
    ]) {
      assert.equal(await provider.provideTokenCount(model, { role: 1, content: [part] }, token), 0);
    }
  } finally {
    provider.dispose();
  }
});

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

test('applies effort settings without leaking thinking into answers or changing tool history', { timeout: 5000 }, async () => {
  const requests = [];
  await withServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    for (const message of [
      { thinking: 'Let ' }, { thinking: 'me think.' },
      { content: 'Checking.', tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: { q: 'x' } } }] }
    ]) response.write(JSON.stringify({ message }) + '\n');
    response.end(JSON.stringify({ done: true, prompt_eval_count: 1000, eval_count: 7 }) + '\n');
  }, async url => {
    const provider = new OllamaLanguageModelProvider();
    const model = { id: 'qwen3.8:27b', name: 'qwen3.8:27b', model: 'qwen3.8:27b', url, headers: {}, local: false,
      thinkingPolicy: { levels: [false, 'low', 'medium', 'xhigh'], defaultLevel: 'medium' } };
    const token = cancellationTokenSource().token;
    const user = { role: 1, content: [new LanguageModelTextPart('Check x')] };
    const progress = collectProgress();
    try {
      settings.thinkingLevels = { [model.model]: 'xhigh' };
      await provider.provideLanguageModelChatResponse(model, [user], {}, progress, token);
      assert.deepEqual(progress.reports.map(part => part.constructor.name), [
        'LanguageModelTextPart', 'LanguageModelToolCallPart', 'LanguageModelDataPart'
      ]);
      assert.equal(progress.reports[0].value, 'Checking.');
      assert.equal(requests[0].think, 'xhigh');
      const history = [user, { role: 2, content: progress.reports.slice(0, -1) }, {
        role: 1, content: [new LanguageModelToolResultPart('call-1', [new LanguageModelTextPart('42')])]
      }];
      settings.thinkingLevels[model.model] = false;
      await provider.provideLanguageModelChatResponse(model, history, {}, collectProgress(), token);
      assert.equal(requests[1].think, false);
      assert.deepEqual(requests[1].messages, [
        { role: 'user', content: 'Check x' },
        { role: 'assistant', content: 'Checking.',
          tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: { q: 'x' } } }] },
        { role: 'tool', content: '42', tool_call_id: 'call-1' }
      ]);
      for (const stale of ['high', 'max', 'none']) {
        settings.thinkingLevels[model.model] = stale;
        await provider.provideLanguageModelChatResponse(model, [user], {}, collectProgress(), token);
        assert.equal(Object.hasOwn(requests.at(-1), 'think'), false);
      }
    } finally {
      provider.dispose();
    }
  });
});

test('cancelling while the server is thinking closes the request and a later chat succeeds', { timeout: 5000 }, async () => {
  let requests = 0;
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  let started;
  const thinkingStarted = new Promise(resolve => { started = resolve; });
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (++requests === 1) {
      response.on('close', closed);
      response.write(JSON.stringify({ message: { thinking: 'Working' } }) + '\n', started);
    } else {
      response.end(JSON.stringify({ message: { content: 'Hello' }, done: true }) + '\n');
    }
  }, async url => {
    const logs = [];
    const provider = new OllamaLanguageModelProvider({ appendLine: line => logs.push(line) });
    const model = { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false };
    const source = cancellationTokenSource();
    const reports = [];
    try {
      const cancelled = provider.provideLanguageModelChatResponse(model, [], {}, {
        report(part) { reports.push(part); }
      }, source.token);
      const rejected = assert.rejects(cancelled, CancellationError);
      await thinkingStarted;
      source.cancel();
      await rejected;
      await connectionClosed;
      assert.deepEqual(reports, []);
      assert.equal(source.listenerCount, 0);
      assert(logs.includes('Chat request to test-model was cancelled.'));
      assert(!logs.some(line => line.includes('request failed')));
      const progress = collectProgress();
      await provider.provideLanguageModelChatResponse(model, [], {}, progress, cancellationTokenSource().token);
      assert.equal(progress.reports[0].value, 'Hello');
    } finally {
      source.dispose();
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

test('includes a stream failure cause in the chat error and diagnostics', { timeout: 5000 }, async () => {
  let serverResponse;
  await withServer((request, response) => {
    request.resume();
    serverResponse = response;
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(`${JSON.stringify({ message: { content: 'partial' } })}\n`);
  }, async url => {
    const logs = [];
    const provider = new OllamaLanguageModelProvider({ appendLine: line => logs.push(line) });
    const model = { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false };
    const source = cancellationTokenSource();
    const reports = [];
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(model, [], {}, {
        report(part) {
          reports.push(part);
          serverResponse.destroy();
        }
      }, source.token), { message: 'terminated: other side closed' });
      assert.deepEqual(reports, [new LanguageModelTextPart('partial')]);
      assert.deepEqual(logs, [
        `Sending chat request to test-model at ${url}.`,
        'Ollama request failed for test-model: terminated: other side closed'
      ]);
    } finally {
      source.dispose();
      provider.dispose();
    }
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

const contextModel = {
  id: 'test-model', name: 'test-model', model: 'test-model', headers: {}, local: true,
  maxInputTokens: 28672, maxOutputTokens: 4096
};
const contextMessages = [
  { role: 1, content: [new LanguageModelTextPart('a'.repeat(20000)),
    new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')] },
  { role: 2, content: [new LanguageModelToolCallPart('read-1', 'read_file', { path: 'app.ts' })] },
  { role: 1, content: [new LanguageModelToolResultPart('read-1', [new LanguageModelTextPart('b'.repeat(48000))])] }
];

for (const local of [true, false]) {
  test(`preserves server context for large ${local ? 'local' : 'cloud'} requests with tool history`, async () => {
    await withContextServer((response) => {
      response.end(JSON.stringify({ message: { content: 'Hello' }, done: true }) + '\n');
    }, async (url, requests) => {
      const provider = new OllamaLanguageModelProvider();
      try {
        for (const messages of [contextMessages, [...contextMessages, { role: 1, content: [new LanguageModelTextPart('c'.repeat(4000))] }]]) {
          await provider.provideLanguageModelChatResponse(
            { ...contextModel, url, local }, messages, { modelOptions: { temperature: 0.2 } },
            collectProgress(), cancellationTokenSource().token
          );
        }
        assert.deepEqual(requests.map(request => request.options), [{ temperature: 0.2 }, { temperature: 0.2 }]);
        for (const request of requests) {
          assert.equal(request.truncate, local ? false : undefined);
          assert.equal(Object.hasOwn(request, 'truncate'), local);
        }
        assert.deepEqual(requests[0].messages, [
          { role: 'user', content: 'a'.repeat(20000), images: ['AQID'] },
          { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', function: { name: 'read_file', arguments: { path: 'app.ts' } } }] },
          { role: 'tool', content: 'b'.repeat(48000), tool_call_id: 'read-1' }
        ]);
      } finally {
        provider.dispose();
      }
    });
  });
}

test('retries the complete request and checks the context loaded by the retry', { timeout: 5000 }, async () => {
  const warnings = [];
  const originalWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async message => { warnings.push(message); };
  let loadedContext = 4096;
  let retryStarted = false;
  let checkedDuringRetry;
  const retryCheck = new Promise(resolve => { checkedDuringRetry = resolve; });
  try {
    await withContextServer(async (response, body, attempt) => {
      if (attempt === 1) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'request (70000 tokens) exceeds the available context size (4096 tokens)' }));
        return;
      }
      retryStarted = true;
      await retryCheck;
      loadedContext = body.options.num_ctx;
      response.end(JSON.stringify({ message: { content: 'Recovered' }, done: true }) + '\n');
    }, async (url, requests) => {
      const provider = new OllamaLanguageModelProvider();
      const model = { ...contextModel, url, maxInputTokens: 126976,
        thinkingPolicy: { levels: [false, 'medium'], defaultLevel: false } };
      settings.thinkingLevels = { [model.model]: 'medium' };
      const options = { modelOptions: { temperature: 0.2 }, tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] };
      const progress = collectProgress();
      try {
        await provider.provideLanguageModelChatResponse(model, contextMessages, options, progress, cancellationTokenSource().token);
        assert.equal(requests.length, 2);
        assert.equal(requests[0].think, 'medium');
        assert.equal(requests[0].tools[0].function.name, 'read_file');
        assert.deepEqual(requests[1], { ...requests[0], options: { temperature: 0.2, num_ctx: 74752 } });
        assert.deepEqual(options.modelOptions, { temperature: 0.2 });
        assert.equal(progress.reports[0].value, 'Recovered');
        assert.deepEqual(warnings, []);
      } finally {
        provider.dispose();
      }
    }, () => {
      if (retryStarted) checkedDuringRetry();
      return [{ model: contextModel.model, context_length: loadedContext }];
    });
  } finally {
    vscode.window.showWarningMessage = originalWarning;
  }
});

test('recovers oversized tool history across retries and provider recreation without trimming it', async () => {
  await withContextServer((response, body) => {
    // Ollama 0.35.0's Qwen renderer rejects history after truncation removes
    // its user query. Disabling truncation exposes the recoverable size error.
    if (body.truncate !== false) {
      response.writeHead(500);
      response.end(JSON.stringify({ error: 'no user query found in messages' }));
      return;
    }
    const allocated = body.options?.num_ctx ?? 4096;
    if (allocated < 12000) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: `request (12000 tokens) exceeds the available context size (${allocated} tokens)` }));
      return;
    }
    response.end(JSON.stringify({ message: { content: 'Recovered' }, done: true }) + '\n');
  }, async (url, requests) => {
    let provider = new OllamaLanguageModelProvider();
    const originalHistory = JSON.stringify(contextMessages);
    const followup = { role: 1, content: [new LanguageModelTextPart('hi')] };
    const send = async messages => {
      const progress = collectProgress();
      await provider.provideLanguageModelChatResponse(
        { ...contextModel, url }, messages, {}, progress, cancellationTokenSource().token
      );
      assert.equal(progress.reports[0].value, 'Recovered');
    };
    try {
      await send(contextMessages);
      await send(contextMessages);
      provider.dispose();
      provider = new OllamaLanguageModelProvider();
      await send(contextMessages);
      await send([...contextMessages, followup]);

      assert.deepEqual(requests.map(request => request.options?.num_ctx), [
        undefined, 16384, 16384, undefined, 16384, 16384
      ]);
      const expectedHistory = [
        { role: 'user', content: 'a'.repeat(20000), images: ['AQID'] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'read-1', function: { name: 'read_file', arguments: { path: 'app.ts' } } }] },
        { role: 'tool', content: 'b'.repeat(48000), tool_call_id: 'read-1' }
      ];
      for (const request of requests.slice(0, -1)) {
        assert.deepEqual(request.messages, expectedHistory);
      }
      assert.deepEqual(requests.at(-1).messages, [...expectedHistory, { role: 'user', content: 'hi' }]);
      assert.equal(JSON.stringify(contextMessages), originalHistory);
    } finally {
      provider.dispose();
    }
  });
});

test('reuses successful context sizes until another error or refresh without leaking across configurations', async () => {
  await withContextServer((response, body, attempt) => {
    if (attempt === 1 || attempt === 5) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: attempt === 1
        ? 'request (12000 tokens) exceeds the available context size (4096 tokens)'
        : 'request (20000 tokens) exceeds the available context size (16384 tokens)' }));
      return;
    }
    response.end(JSON.stringify({ message: { content: 'Hello' }, done: true }) + '\n');
  }, async (url, requests) => {
    const provider = new OllamaLanguageModelProvider();
    const model = { ...contextModel, url };
    const token = cancellationTokenSource().token;
    try {
      for (const messages of [contextMessages, [], contextMessages, contextMessages, []]) {
        await provider.provideLanguageModelChatResponse(model, messages, {}, collectProgress(), token);
      }
      assert.deepEqual(requests.map(request => request.options?.num_ctx), [undefined, 16384, 16384, 16384, 16384, 24576, 24576]);
      for (const changed of [
        { model: 'another-model' }, { headers: { Authorization: 'test-credential' } },
        { maxInputTokens: 12288 }, { local: false }
      ]) {
        await provider.provideLanguageModelChatResponse({ ...model, ...changed }, [], {}, collectProgress(), token);
        assert.equal(requests.at(-1).options?.num_ctx, undefined);
      }
      await provider.provideLanguageModelChatResponse(model, [], { modelOptions: { num_ctx: 8192 } }, collectProgress(), token);
      assert.equal(requests.at(-1).options.num_ctx, 8192);
      await withContextServer(response => {
        response.end(JSON.stringify({ done: true }) + '\n');
      }, async (otherURL, otherRequests) => {
        await provider.provideLanguageModelChatResponse({ ...model, url: otherURL }, [], {}, collectProgress(), token);
        assert.equal(otherRequests[0].options?.num_ctx, undefined);
      });
      provider.refresh();
      await provider.provideLanguageModelChatResponse(model, [], {}, collectProgress(), token);
      assert.equal(requests.at(-1).options?.num_ctx, undefined);
    } finally {
      provider.dispose();
    }
  });
});

for (const { name, local = true, num_ctx, requested = 12000 } of [
  { name: 'an explicit limit', num_ctx: 4096 },
  { name: 'an explicit automatic value', num_ctx: 0 },
  { name: 'an explicit sentinel value', num_ctx: -1 },
  { name: 'a cloud model', local: false },
  { name: 'a prompt beyond the model maximum', requested: 35000 }
]) {
  test(`does not retry a context error for ${name}`, async () => {
    await withContextServer(response => {
      response.writeHead(400);
      response.end(JSON.stringify({ error: `request (${requested} tokens) exceeds the available context size (4096 tokens)` }));
    }, async (url, requests) => {
      const provider = new OllamaLanguageModelProvider();
      try {
        await assert.rejects(provider.provideLanguageModelChatResponse(
          { ...contextModel, url, local }, contextMessages, { modelOptions: { num_ctx } },
          collectProgress(), cancellationTokenSource().token
        ), requested > 32768 ? /maximum context window \(32K\)/ : /allocated context window \(4K\)/);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].options.num_ctx, num_ctx);
      } finally {
        provider.dispose();
      }
    });
  });
}

test('stops after one failed retry without caching its context or claiming the model maximum was exceeded', async () => {
  await withContextServer((response, body, attempt) => {
    if (attempt <= 2) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: 'request (12000 tokens) exceeds the available context size (4096 tokens)' }));
      return;
    }
    response.end(JSON.stringify({ done: true }) + '\n');
  }, async (url, requests) => {
    const provider = new OllamaLanguageModelProvider();
    const model = { ...contextModel, url };
    const token = cancellationTokenSource().token;
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(model, [], {}, collectProgress(), token), /allocated context window \(4K\)/);
      assert.equal(requests.length, 2);
      await provider.provideLanguageModelChatResponse(model, [], {}, collectProgress(), token);
      assert.equal(requests[2].options?.num_ctx, undefined);
    } finally {
      provider.dispose();
    }
  });
});

test('cancels a context retry without caching it and allows the next request', { timeout: 5000 }, async () => {
  let started;
  const retryStarted = new Promise(resolve => { started = resolve; });
  let closed;
  const retryClosed = new Promise(resolve => { closed = resolve; });
  await withContextServer((response, body, attempt) => {
    if (attempt === 1) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: 'request (12000 tokens) exceeds the available context size (4096 tokens)' }));
    } else if (attempt === 2) {
      response.on('close', closed);
      started();
    } else {
      response.end(JSON.stringify({ done: true }) + '\n');
    }
  }, async (url, requests) => {
    const provider = new OllamaLanguageModelProvider();
    const model = { ...contextModel, url };
    const source = cancellationTokenSource();
    try {
      const rejected = assert.rejects(provider.provideLanguageModelChatResponse(model, [], {}, collectProgress(), source.token), CancellationError);
      await retryStarted;
      source.cancel();
      await rejected;
      await retryClosed;
      assert.equal(source.listenerCount, 0);
      await provider.provideLanguageModelChatResponse(model, [], {}, collectProgress(), cancellationTokenSource().token);
      assert.deepEqual(requests.map(request => request.options?.num_ctx), [undefined, 16384, undefined]);
    } finally {
      source.dispose();
      provider.dispose();
    }
  });
});

test('does not replay tool calls after a streamed context error', async () => {
  await withContextServer(response => {
    response.write(JSON.stringify({ message: { tool_calls: [{ id: 'call-1', function: { name: 'lookup', arguments: {} } }] } }) + '\n');
    response.end(JSON.stringify({ error: 'request (12000 tokens) exceeds the available context size (4096 tokens)' }) + '\n');
  }, async (url, requests) => {
    const provider = new OllamaLanguageModelProvider();
    const progress = collectProgress();
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(
        { ...contextModel, url }, [], {}, progress, cancellationTokenSource().token
      ), /allocated context window/);
      assert.equal(requests.length, 1);
      assert.deepEqual(progress.reports, [new LanguageModelToolCallPart('call-1', 'lookup', {})]);
    } finally {
      provider.dispose();
    }
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

test('cancels before response headers and closes the pending HTTP request', { timeout: 5000 }, async () => {
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  let chatStarted;
  const chatReceived = new Promise(resolve => { chatStarted = resolve; });
  await withServer((request, response) => {
    request.resume();
    response.on('close', closed);
    chatStarted();
  }, async url => {
    const provider = new OllamaLanguageModelProvider();
    const model = { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false };
    const source = cancellationTokenSource();
    try {
      const responsePromise = provider.provideLanguageModelChatResponse(
        model,
        [],
        {},
        collectProgress(),
        source.token
      );
      await chatReceived;
      source.cancel();
      await assert.rejects(responsePromise, CancellationError);
      await connectionClosed;
      assert.equal(source.listenerCount, 0);
    } finally {
      source.dispose();
      provider.dispose();
    }
  });
});

test('aborts a stream that resolves after cancellation and disposes its listener', async t => {
  let resolveStream;
  let chatStarted;
  const started = new Promise(resolve => { chatStarted = resolve; });
  t.mock.method(Ollama.prototype, 'chat', () => {
    chatStarted();
    return new Promise(resolve => { resolveStream = resolve; });
  });
  const controller = new AbortController();
  const stream = {
    abort() { controller.abort(); },
    async *[Symbol.asyncIterator]() {
      controller.signal.throwIfAborted();
      yield { message: { content: 'must not escape' }, done: true };
    }
  };
  const provider = new OllamaLanguageModelProvider();
  const source = cancellationTokenSource();
  const progress = collectProgress();
  try {
    const response = provider.provideLanguageModelChatResponse(
      { id: 'test-model', name: 'test-model', model: 'test-model', url: 'http://127.0.0.1:1', headers: {}, local: false },
      [], {}, progress, source.token
    );
    await started;
    source.cancel();
    resolveStream(stream);
    await assert.rejects(response, CancellationError);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(progress.reports, []);
    assert.equal(source.listenerCount, 0);
  } finally {
    source.dispose();
    provider.dispose();
  }
});

for (const location of ['in later chunks', 'in the same chunk', 'at completion']) {
  test(`cancellation drops buffered output ${location}`, { timeout: 5000 }, async () => {
    let requests = 0;
    await withServer((request, response) => {
      request.resume();
      requests++;
      const tool_calls = [{ id: 'call-1', function: { name: 'lookup', arguments: {} } }];
      // One write deliberately makes multiple SDK messages available before abort.
      response.end((location === 'at completion' ? [
        { message: { content: 'first' }, done: true, prompt_eval_count: 10, eval_count: 2 }
      ] : [
        { message: { content: 'first', ...(location === 'in the same chunk' ? { tool_calls } : {}) } },
        { message: { content: 'must not escape', tool_calls } },
        { done: true, prompt_eval_count: 10, eval_count: 2 }
      ]).map(chunk => JSON.stringify(chunk) + '\n').join(''));
    }, async url => {
      const provider = new OllamaLanguageModelProvider();
      const source = cancellationTokenSource();
      const reports = [];
      try {
        let error;
        try {
          await provider.provideLanguageModelChatResponse(
            { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false }, [], {}, {
              report(part) { reports.push(part); source.cancel(); }
            }, source.token
          );
        } catch (caught) { error = caught; }
        assert.deepEqual(reports, [new LanguageModelTextPart('first')]);
        assert(error instanceof CancellationError, String(error));
        assert.equal(requests, 1);
        assert.equal(source.listenerCount, 0);
      } finally {
        source.dispose();
        provider.dispose();
      }
    });
  });
}

test('cancellation before a context retry prevents another HTTP request', { timeout: 5000 }, async () => {
  await withContextServer(response => {
    response.writeHead(400);
    response.end(JSON.stringify({ error: 'request (12000 tokens) exceeds the available context size (4096 tokens)' }));
  }, async (url, requests) => {
    const source = cancellationTokenSource();
    const provider = new OllamaLanguageModelProvider({
      appendLine(line) { if (line.includes('Retrying')) source.cancel(); }
    });
    try {
      await assert.rejects(provider.provideLanguageModelChatResponse(
        { ...contextModel, url }, [], {}, collectProgress(), source.token
      ), CancellationError);
      assert.equal(requests.length, 1);
      assert.equal(source.listenerCount, 0);
    } finally {
      source.dispose();
      provider.dispose();
    }
  });
});

for (const doneReason of [false, true]) {
  test(`aborts a failed stream ${doneReason ? 'after a done_reason marker' : 'before completion'}`, { timeout: 5000 }, async t => {
    const aborts = trackStreamAborts(t);
    let closed;
    const connectionClosed = new Promise(resolve => { closed = resolve; });
    await withServer((request, response) => {
      request.resume();
      response.on('close', closed);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify({ message: { content: 'partial' }, ...(doneReason ? { done_reason: 'stop' } : {}) }) + '\n');
      response.write(JSON.stringify({ error: 'stream failed' }) + '\n');
      // Leave HTTP open: the provider must actively release the connection.
    }, async url => {
      const provider = new OllamaLanguageModelProvider();
      const source = cancellationTokenSource();
      const progress = collectProgress();
      try {
        await assert.rejects(provider.provideLanguageModelChatResponse(
          { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false }, [], {}, progress, source.token
        ), { message: 'stream failed' });
        await connectionClosed;
        assert.equal(aborts.length, 1);
        assert.equal(aborts[0].mock.callCount(), 1);
        assert.deepEqual(progress.reports, [new LanguageModelTextPart('partial')]);
        assert.equal(source.listenerCount, 0);
      } finally {
        source.dispose();
        provider.dispose();
      }
    });
  });
}

test('aborts active stream in finally when an error occurs during streaming', { timeout: 5000 }, async t => {
  const aborts = trackStreamAborts(t);
  let closed;
  const connectionClosed = new Promise(resolve => { closed = resolve; });
  await withServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.on('close', closed);
    response.write(JSON.stringify({ message: { content: 'first' } }) + '\n');
  }, async url => {
    const provider = new OllamaLanguageModelProvider();
    const model = { id: 'test-model', name: 'test-model', model: 'test-model', url, headers: {}, local: false };
    try {
      await assert.rejects(
        provider.provideLanguageModelChatResponse(
          model,
          [],
          {},
          {
            report() {
              throw new Error('consumer error');
            }
          },
          cancellationTokenSource().token
        ),
        /consumer error/
      );
      await connectionClosed;
      assert.equal(aborts.length, 1);
      assert.equal(aborts[0].mock.callCount(), 1);
    } finally {
      provider.dispose();
    }
  });
});

function trackStreamAborts(t) {
  const aborts = [];
  const chat = Ollama.prototype.chat;
  t.mock.method(Ollama.prototype, 'chat', async function(request) {
    const stream = await chat.call(this, request);
    aborts.push(t.mock.method(stream, 'abort'));
    return stream;
  });
  return aborts;
}

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
    get listenerCount() { return listeners.size; },
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

async function withContextServer(handleChat, run, listModels = () => []) {
  const requests = [];
  await withServer(async (request, response) => {
    if (request.url === '/api/ps') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ models: await listModels() }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const chat = JSON.parse(body);
    requests.push(chat);
    response.setHeader('content-type', 'application/x-ndjson');
    await handleChat(response, chat, requests.length);
  }, url => run(url, requests));
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

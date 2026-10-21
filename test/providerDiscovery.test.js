const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

// Exercise discovery with the real Ollama client; only the VS Code API is mocked.
// VS Code's aggregation of default and configured provider groups needs a host test.
class EventEmitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire() { for (const listener of this.listeners) listener(); }
  dispose() { this.listeners.clear(); }
}

class CancellationTokenSource {
  emitter = new EventEmitter();
  token = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel() {
    if (!this.token.isCancellationRequested) {
      this.token.isCancellationRequested = true;
      this.emitter.fire();
    }
  }
  dispose() { this.emitter.dispose(); }
}

let settings = {};
const vscode = {
  EventEmitter,
  CancellationTokenSource,
  workspace: { getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }) }
};
const originalLoad = Module._load;
let OllamaLanguageModelProvider;
try {
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  ({ OllamaLanguageModelProvider } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const tags = [
  { name: 'gemma4:12b-mlx', capabilities: ['completion', 'tools', 'vision'] },
  { name: 'qwen3.5:9b-mlx', capabilities: ['completion', 'tools'] },
  { name: 'Same display name', model: 'server/vision:latest', capabilities: ['completion', 'vision'] },
  { name: 'Same display name', model: 'server/text:latest', capabilities: ['completion'] }
];
const ids = tags.map(model => model.model ?? model.name);

async function fixture(t, stallPath) {
  const requests = [];
  let stalled;
  const whenStalled = new Promise(resolve => { stalled = resolve; });
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, headers: request.headers });
    if (request.url === stallPath) {
      stalled();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    let result;
    switch (request.url) {
      case '/api/version': result = { version: 'fixture' }; break;
      case '/api/tags': result = { models: tags }; break;
      case '/api/experimental/model-recommendations': result = { models: [] }; break;
      case '/api/show':
        result = { ...tags.find(model => (model.model ?? model.name) === JSON.parse(body).model),
          model_info: { 'fixture.context_length': 32768 } };
        break;
      default: response.statusCode = 404; result = { error: 'Unknown route' };
    }
    response.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, whenStalled };
}

function provider(t) {
  const value = new OllamaLanguageModelProvider();
  t.after(() => value.dispose());
  return value;
}

test('unique tags stay unique across repeated discovery and refresh', async t => {
  const server = await fixture(t);
  settings = { endpoint: server.url };
  const value = provider(t);
  let refreshes = 0;
  value.onDidChangeLanguageModelChatInformation(() => refreshes++);
  for (let i = 0; i < 3; i++) {
    if (i > 0) value.refresh();
    const models = await value.provideLanguageModelChatInformation({}, token);
    assert.deepEqual(models.map(model => model.id), ids);
    assert.deepEqual(models.map(model => model.capabilities), [
      { toolCalling: true, imageInput: true },
      { toolCalling: true, imageInput: false },
      { toolCalling: false, imageInput: true },
      { toolCalling: false, imageInput: false }
    ]);
  }
  assert.equal(refreshes, 2);
  assert.equal(server.requests.filter(request => request.path === '/api/tags').length, 3);
});

test('default and configured discovery each return a complete independent model list', async t => {
  const server = await fixture(t);
  settings = { endpoint: server.url };
  const value = provider(t);
  for (const options of [{}, { configuration: { url: server.url } }, {}]) {
    const models = await value.provideLanguageModelChatInformation(options, token);
    assert.deepEqual(models.map(model => model.id), ids);
    assert.ok(models.every(model => model.url === server.url));
  }
});

test('disabling automatic discovery skips all default requests and can be reversed', async t => {
  const server = await fixture(t);
  settings = { endpoint: server.url, autoDiscoverModels: false };
  const value = provider(t);
  for (let i = 0; i < 3; i++) {
    value.refresh();
    assert.deepEqual(await value.provideLanguageModelChatInformation({}, token), []);
  }
  assert.deepEqual(server.requests, []);

  settings.autoDiscoverModels = true;
  assert.deepEqual((await value.provideLanguageModelChatInformation({}, token)).map(model => model.id), ids);
  const requestCount = server.requests.length;
  settings.autoDiscoverModels = false;
  assert.deepEqual(await value.provideLanguageModelChatInformation({}, token), []);
  assert.equal(server.requests.length, requestCount);
});

test('saved groups using default settings still work with automatic discovery disabled', async t => {
  const server = await fixture(t);
  settings = { endpoint: server.url, headers: { 'X-Fixture-Group': 'default' }, autoDiscoverModels: false };
  const value = provider(t);
  // Even identical saved groups are independent identities in VS Code.
  for (let i = 0; i < 2; i++) {
    const models = await value.provideLanguageModelChatInformation({ configuration: {} }, token);
    assert.deepEqual(models.map(model => model.id), ids);
    assert.ok(models.every(model => model.url === server.url));
    assert.ok(models.every(model => model.headers['X-Fixture-Group'] === 'default'));
  }
  assert.equal(server.requests.filter(request => request.path === '/api/tags').length, 2);
});

test('disabling discovery interrupts each HTTP phase before resolving saved groups', async t => {
  const phases = ['/api/version', '/api/tags', '/api/experimental/model-recommendations', '/api/show'];
  for (const phase of phases) {
    await t.test(phase, { timeout: 3000 }, async t => {
      const automatic = await fixture(t, phase);
      const saved = await fixture(t);
      settings = { endpoint: automatic.url };
      const value = provider(t);
      const pending = value.provideLanguageModelChatInformation({}, token);
      await automatic.whenStalled;
      settings.autoDiscoverModels = false;
      value.refresh();

      assert.deepEqual(await pending, []);
      assert.ok(automatic.requests.every(request => phases.indexOf(request.path) <= phases.indexOf(phase)));
      const models = await value.provideLanguageModelChatInformation({ configuration: { url: saved.url } }, token);
      assert.deepEqual(models.map(model => model.id), ids);
    });
  }
});

test('disposal and caller cancellation interrupt discovery', async t => {
  for (const action of ['dispose', 'cancel']) {
    await t.test(action, { timeout: 3000 }, async t => {
      const server = await fixture(t, '/api/tags');
      settings = { endpoint: server.url };
      const value = provider(t);
      const source = new CancellationTokenSource();
      t.after(() => source.dispose());
      const pending = value.provideLanguageModelChatInformation({ configuration: {} }, source.token);
      await server.whenStalled;
      if (action === 'dispose') value.dispose();
      else source.cancel();
      assert.deepEqual(await pending, []);
      assert.equal(source.emitter.listeners.size, 0);
      assert.deepEqual(server.requests.map(request => request.path), ['/api/version', '/api/tags']);
    });
  }
});

test('already-cancelled discovery makes no requests', async t => {
  const server = await fixture(t);
  settings = { endpoint: server.url };
  const value = provider(t);
  const source = new CancellationTokenSource();
  t.after(() => source.dispose());
  source.cancel();
  assert.deepEqual(await value.provideLanguageModelChatInformation({}, source.token), []);
  assert.deepEqual(server.requests, []);
  assert.equal(source.emitter.listeners.size, 0);
});

test('provider endpoints, headers and model filters remain independent for matching IDs', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  settings = { endpoint: first.url, headers: { 'X-Fixture-Group': 'default' } };
  const value = provider(t);
  const defaults = await value.provideLanguageModelChatInformation({}, token);
  assert.deepEqual(defaults.map(model => model.id), ids);
  settings.autoDiscoverModels = false;
  for (const url of [first.url, second.url]) {
    const models = await value.provideLanguageModelChatInformation({ configuration: {
      url, models: [ids[0], ids[3]], headers: { 'X-Fixture-Group': 'configured' }
    } }, token);
    assert.deepEqual(models.map(model => model.id), [ids[0], ids[3]]);
    assert.ok(models.every(model => model.url === url));
    assert.ok(models.every(model => model.headers['X-Fixture-Group'] === 'configured'));
    assert.equal(models[1].capabilities.toolCalling, false);
    assert.equal(models[1].capabilities.imageInput, false);
  }
  assert.ok(defaults.every(model => model.url === first.url));
  assert.ok(defaults.every(model => model.headers['X-Fixture-Group'] === 'default'));
  assert.deepEqual(first.requests.filter(request => request.path === '/api/tags')
    .map(request => request.headers['x-fixture-group']), ['default', 'configured']);
  assert.deepEqual(second.requests.filter(request => request.path === '/api/tags')
    .map(request => request.headers['x-fixture-group']), ['configured']);
});

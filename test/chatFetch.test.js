const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

const { createChatFetch } = require('../out/chatFetch');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

let createFetch;
let disposeAll;
try {
  ({ createFetch, disposeAll } = require('../out/provider'));
} finally {
  Module._load = originalLoad;
}

test('waits for delayed response headers', async () => {
  await withServer((request, response) => {
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('{"done":true}\n');
    }, 75);
  }, async url => {
    const transport = createChatFetch();
    try {
      const response = await transport.fetch(`${url}/api/chat`, {
        method: 'POST',
        body: '{}'
      });
      assert.equal(await response.text(), '{"done":true}\n');
    } finally {
      transport.dispose();
    }
  });
});

test('supports a finite response header timeout for the test control', async () => {
  await withServer((request, response) => {
    request.resume();
    setTimeout(() => response.end('too late'), 1500);
  }, async url => {
    const transport = createChatFetch(100);
    try {
      await assert.rejects(
        transport.fetch(`${url}/api/chat`),
        error => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT'
      );
    } finally {
      transport.dispose();
    }
  });
});

test('links VS Code cancellation to the chat request', async () => {
  let requestClosed;
  let markRequestStarted;
  const requestStarted = new Promise(resolve => {
    markRequestStarted = resolve;
  });
  await withServer(request => {
    request.resume();
    requestClosed = new Promise(resolve => request.on('close', resolve));
    markRequestStarted();
  }, async url => {
    const source = cancellationTokenSource();
    const disposables = [];
    const transport = createChatFetch();
    const request = createFetch(source.token, disposables, transport.fetch);

    try {
      const pending = request(`${url}/api/chat`, { method: 'POST', body: '{}' });
      await requestStarted;
      source.cancel();
      await assert.rejects(pending, error => error.name === 'AbortError');
      await requestClosed;
    } finally {
      disposeAll(disposables);
      transport.dispose();
    }
  });
});

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

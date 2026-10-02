const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const { promisify } = require('node:util');
const test = require('node:test');

if (process.argv.includes('--lifetime-probe')) {
  runProbe().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  test('keeps an SDK stream alive while context checking delays reading', async () => {
    await promisify(execFile)(process.execPath, [
      '--expose-gc', __filename, '--lifetime-probe'
    ], { timeout: 10000 });
  });

  test('still aborts an unread SDK stream when cancellation is requested', async () => {
    const { Ollama } = require('ollama');
    const { createChatFetch } = require('../out/chatFetch');
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('{"message":{"content":"partial"},"done":false}\n');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const transport = createChatFetch(1000);
    const client = new Ollama({
      host: `http://127.0.0.1:${server.address().port}`,
      fetch: transport.fetch
    });
    try {
      const stream = await client.chat({ model: 'test-model', messages: [], stream: true });
      stream.abort();
      await assert.rejects(async () => {
        for await (const chunk of stream) {
          void chunk;
        }
      }, error => error.name === 'AbortError');
    } finally {
      transport.dispose();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function runProbe() {
  const { Ollama } = require('ollama');
  const { createChatFetch } = require('../out/chatFetch');
  assert.equal(typeof global.gc, 'function');

  let finishResponse;
  const finish = new Promise(resolve => { finishResponse = resolve; });
  const server = http.createServer(async (request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('{"message":{"content":"hello"},"done":false}\n');
    await finish;
    if (!response.destroyed) {
      response.end('{"message":{"content":" world"},"done":true}\n');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const transport = createChatFetch(1000);
  const client = new Ollama({
    host: `http://127.0.0.1:${server.address().port}`,
    fetch: transport.fetch
  });

  try {
    const stream = await client.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    });
    // The provider awaits its context check after chat() returns the lazy
    // iterator. Collect the SDK's Response during that gap, before getReader().
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      global.gc();
    }
    finishResponse();
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.equal(chunks.at(-1).done, true);
    assert.equal(chunks.map(chunk => chunk.message?.content || '').join(''), 'hello world');
  } finally {
    finishResponse();
    transport.dispose();
    await new Promise(resolve => server.close(resolve));
  }
}

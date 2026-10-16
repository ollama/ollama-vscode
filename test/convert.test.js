const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelThinkingPart {
  constructor(value, id, metadata) {
    this.value = value;
    this.id = id;
    this.metadata = metadata;
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.mimeType = mimeType;
    this.data = data;
  }

  toJSON() {
    return {
      $mid: 24,
      mimeType: this.mimeType,
      data: Buffer.from(this.data).toString('base64')
    };
  }
}

class LanguageModelToolCallPart {}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

const vscode = {
  LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let isDataPart;
let isTextPart;
let isToolCallPart;
let isToolResultPart;
let toOllamaMessages;
let toOllamaTools;
try {
  ({
    isDataPart,
    isTextPart,
    isToolCallPart,
    isToolResultPart,
    toOllamaMessages,
    toOllamaTools
  } = require('../out/convert'));
} finally {
  Module._load = originalLoad;
}

test('preserves nonempty tool schemas including constraints and unsupported features', () => {
  const schemas = [
    { type: 'object', properties: { city: { type: 'string', enum: ['Toronto'] } }, required: ['city'], additionalProperties: false },
    { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] },
    { $ref: '#/$defs/input', $defs: { input: { type: 'object' } } },
    { properties: { value: { type: 'string' } } },
    { type: '', properties: null }
  ].map(Object.freeze);
  for (const inputSchema of schemas) {
    const tool = Object.freeze({ name: 'example', description: 'Example tool.', inputSchema });
    assert.equal(toOllamaTools([tool])[0].function.parameters, inputSchema);
  }
});

test('omits cache control and unrecognized provider metadata from tool results', () => {
  const result = new LanguageModelToolResultPart('call-1', [
    new LanguageModelTextPart('first'),
    new LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control'),
    new LanguageModelDataPart(new TextEncoder().encode('provider metadata'), 'application/vnd.provider.metadata'),
    new LanguageModelDataPart(new TextEncoder().encode('second'), 'text/plain')
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: 'first\nsecond',
    tool_call_id: 'call-1'
  }]);
});

test('preserves an empty tool result when it only contains provider metadata', () => {
  const result = new LanguageModelToolResultPart('call-2', [
    new LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control'),
    new LanguageModelDataPart(new TextEncoder().encode('provider metadata'), 'application/vnd.provider.metadata')
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: '',
    tool_call_id: 'call-2'
  }]);
});

test('preserves text, supported JSON data, and JSON-compatible tool result content', () => {
  const result = new LanguageModelToolResultPart('call-3', [
    new LanguageModelTextPart('first'),
    new LanguageModelDataPart(new TextEncoder().encode('second'), 'text/plain'),
    new LanguageModelDataPart(new TextEncoder().encode('{"status":"ok"}'), 'application/json; charset=utf-8'),
    new LanguageModelDataPart(new TextEncoder().encode('{"vendor":true}'), 'application/vnd.example+json'),
    { legacy: true },
    { value: '42', unit: 'ms', source: 'synthetic timer' }
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: 'first\nsecond\n{"status":"ok"}\n{"vendor":true}\n{"legacy":true}\n{"value":"42","unit":"ms","source":"synthetic timer"}',
    tool_call_id: 'call-3'
  }]);
});

test('preserves image data on regular chat messages', () => {
  const imageBytes = Uint8Array.from([0, 1, 2, 3]);

  assert.deepEqual(toOllamaMessages([{
    role: 1,
    content: [new LanguageModelDataPart(imageBytes, 'image/png')]
  }]), [{
    role: 'user',
    content: '',
    images: [Buffer.from(imageBytes).toString('base64')],
    tool_calls: undefined
  }]);
});

test('forwards image data from tool results on the corresponding tool message', () => {
  const imageBytes = Uint8Array.from([0, 1, 2, 3]);
  const result = new LanguageModelToolResultPart('call-4', [
    new LanguageModelTextPart('browser screenshot'),
    new LanguageModelDataPart(imageBytes, 'image/png')
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: 'browser screenshot',
    images: [Buffer.from(imageBytes).toString('base64')],
    tool_call_id: 'call-4'
  }]);
});

test('converts plain message parts that do not inherit from vscode classes', () => {
  const plainTextPart = { value: 'Hello from remote host', audience: [0] };
  const plainDataPart = { mimeType: 'text/plain', data: new TextEncoder().encode('decoded note') };
  const plainToolCallPart = {
    callId: 'call-5',
    name: 'fetch_docs',
    input: { query: 'ollama' }
  };
  const plainToolResultPart = {
    callId: 'call-5',
    content: [{ value: 'result text' }]
  };

  assert.deepEqual(toOllamaMessages([
    { role: 1, content: [plainTextPart, plainDataPart] },
    { role: 2, content: [plainToolCallPart] },
    { role: 1, content: [plainToolResultPart] }
  ]), [
    {
      role: 'user',
      content: 'Hello from remote host\ndecoded note',
      images: undefined,
      tool_calls: undefined
    },
    {
      role: 'assistant',
      content: '',
      images: undefined,
      tool_calls: [{
        id: 'call-5',
        function: {
          name: 'fetch_docs',
          arguments: { query: 'ollama' }
        }
      }]
    },
    {
      role: 'tool',
      content: 'result text',
      tool_call_id: 'call-5'
    }
  ]);
});

test('preserves foreign-realm text, byte arrays, and nested tool results', () => {
  const messages = runInNewContext(`(() => {
    class TextPart {
      constructor(value, audience) { this.value = value; this.audience = audience; }
    }
    class DataPart {
      constructor(data, mimeType) { this.data = data; this.mimeType = mimeType; }
    }
    const image = new DataPart(new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4), 'image/png');
    return [
      { role: 1, content: [new TextPart('hello'), new DataPart(new Uint8Array([104, 105]), 'text/plain'), image] },
      { role: 2, content: [{ callId: 'foreign-call', name: 'lookup', input: {} }] },
      { role: 1, content: [{ callId: 'foreign-call', content: [new TextPart('result', [0]), image] }] }
    ];
  })()`);

  assert.equal(messages[0].content[0] instanceof LanguageModelTextPart, false);
  assert.equal(messages[0].content[1].data instanceof Uint8Array, false);
  assert.deepEqual(JSON.parse(JSON.stringify(toOllamaMessages(messages))), [
    { role: 'user', content: 'hello\nhi', images: ['AQID'] },
    { role: 'assistant', content: '',
      tool_calls: [{ id: 'foreign-call', function: { name: 'lookup', arguments: {} } }] },
    { role: 'tool', content: 'result', images: ['AQID'], tool_call_id: 'foreign-call' }
  ]);
});

test('excludes thinking and unrevived serialized parts from ordinary text', () => {
  const thinking = new LanguageModelThinkingPart('private thinking');
  const parts = [
    thinking,
    new LanguageModelThinkingPart('private thinking', 'thinking-id', { signature: 'fixture' }),
    structuredClone(thinking),
    // The marshalling marker distinguishes serialized parts even without id/metadata.
    { $mid: 999, value: 'serialized thinking' }
  ];
  for (const part of parts) {
    assert.equal(isTextPart(part), false);
    assert.deepEqual(toOllamaMessages([{
      role: 2, content: [part, new LanguageModelTextPart('answer')]
    }]), [{ role: 'assistant', content: 'answer', images: undefined, tool_calls: undefined }]);
  }
});

test('requires byte arrays instead of treating serialized data as runtime media', () => {
  for (const mimeType of ['image/png', 'text/plain', 'application/json']) {
    const serialized = JSON.parse(JSON.stringify(new LanguageModelDataPart(new Uint8Array([1, 2, 3]), mimeType)));
    for (const part of [
      serialized,
      { mimeType, data: JSON.parse(JSON.stringify(new Uint8Array([1, 2, 3]))) },
      new LanguageModelDataPart(serialized.data, mimeType)
    ]) {
      assert.equal(isDataPart(part), false);
      assert.deepEqual(toOllamaMessages([{ role: 1, content: [part] }]), []);
      // Preserve the existing JSON fallback for unrecognized tool-result values.
      assert.equal(toOllamaMessages([{
        role: 1, content: [new LanguageModelToolResultPart('serialized-call', [part])]
      }])[0].content, JSON.stringify(part));
    }
  }
  assert.equal(isDataPart({ mimeType: 'image/png', data: Buffer.from([1, 2, 3]) }), true);
  assert.equal(isDataPart({ mimeType: 'image/png', data: new Uint16Array([1, 2, 3]) }), false);
});

test('structural type guards identify plain objects and reject mismatched shapes', () => {
  assert.equal(isTextPart({ value: 'hello' }), true);
  assert.equal(isTextPart(new LanguageModelTextPart('hello')), true);
  assert.equal(isTextPart({ value: 123 }), false);
  assert.equal(isTextPart({ callId: '1', name: 'tool' }), false);
  assert.equal(isTextPart(null), false);

  assert.equal(isDataPart({ mimeType: 'text/plain', data: new Uint8Array() }), true);
  assert.equal(isDataPart(new LanguageModelDataPart(new Uint8Array(), 'image/png')), true);
  assert.equal(isDataPart({ mimeType: 'text/plain' }), false);
  assert.equal(isDataPart({ data: new Uint8Array() }), false);

  assert.equal(isToolCallPart({ callId: 'c1', name: 't1', input: {} }), true);
  assert.equal(isToolCallPart({ callId: 'c1', content: [] }), false);

  assert.equal(isToolResultPart({ callId: 'c1', content: [] }), true);
  assert.equal(isToolResultPart({ callId: 'c1', name: 't1' }), false);
});

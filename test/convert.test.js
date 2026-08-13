const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
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

let toOllamaMessages;
try {
  ({ toOllamaMessages } = require('../out/convert'));
} finally {
  Module._load = originalLoad;
}

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
    { legacy: true }
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: 'first\nsecond\n{"status":"ok"}\n{"vendor":true}\n{"legacy":true}',
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

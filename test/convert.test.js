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

test('omits cache control metadata from tool results', () => {
  const result = new LanguageModelToolResultPart('call-1', [
    new LanguageModelTextPart('first'),
    new LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control'),
    new LanguageModelDataPart(new TextEncoder().encode('second'), 'text/plain')
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: 'first\nsecond',
    tool_call_id: 'call-1'
  }]);
});

test('preserves an empty tool result when it only contains cache control metadata', () => {
  const result = new LanguageModelToolResultPart('call-2', [
    new LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control')
  ]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: '',
    tool_call_id: 'call-2'
  }]);
});

test('keeps the existing fallback for unknown tool result content', () => {
  const result = new LanguageModelToolResultPart('call-3', [{ status: 'ok' }]);

  assert.deepEqual(toOllamaMessages([{ role: 1, content: [result] }]), [{
    role: 'tool',
    content: '{"status":"ok"}',
    tool_call_id: 'call-3'
  }]);
});

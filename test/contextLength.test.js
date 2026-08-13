const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatContextLength,
  isMachineContextTooSmall,
  machineContextLength,
  minimumMachineContextLength,
  waitForMachineContextCheckBeforeStreaming,
  waitForMachineContextLength
} = require('../out/contextLength');

test('warns only below the 64K machine context threshold', () => {
  assert.equal(minimumMachineContextLength, 65536);
  assert.equal(isMachineContextTooSmall(65535), true);
  assert.equal(isMachineContextTooSmall(65536), false);
  assert.equal(isMachineContextTooSmall(131072), false);
});

test('reads the allocated context from the matching running model', () => {
  assert.equal(machineContextLength([
    { name: 'other:latest', context_length: 131072 },
    {
      name: 'gemma3:latest',
      context_length: 32768,
      model_info: { 'gemma3.context_length': 131072 }
    }
  ], 'gemma3'), 32768);
});

test('matches latest aliases and ignores invalid process context values', () => {
  assert.equal(machineContextLength([
    { model: 'qwen3.5:latest', context_length: 65536 }
  ], 'QWEN3.5'), 65536);

  for (const contextLength of [undefined, 0, -1, 1.5, '32768']) {
    assert.equal(machineContextLength([
      { name: 'qwen3.5', context_length: contextLength }
    ], 'qwen3.5'), undefined);
  }
});

test('does not treat model metadata as the runtime context allocation', () => {
  assert.equal(machineContextLength([
    {
      name: 'gemma3:latest',
      details: { context_length: 32768 },
      model_info: { 'gemma3.context_length': 131072 }
    }
  ], 'gemma3'), undefined);
});

test('does not use the context allocation from a different running model', () => {
  assert.equal(machineContextLength([
    { name: 'qwen3.5:latest', context_length: 32768 }
  ], 'gemma3'), undefined);
});

test('formats binary context sizes for the warning', () => {
  assert.equal(formatContextLength(32768), '32K');
  assert.equal(formatContextLength(65536), '64K');
  assert.equal(formatContextLength(64000), '64,000');
});

test('polls for the machine context while the chat request is loading', async () => {
  let requestSettled = false;
  let checks = 0;
  let waits = 0;
  const contextLength = await waitForMachineContextLength(
    async () => ++checks === 1
      ? []
      : [{ name: 'gemma3', context_length: 32768 }],
    'gemma3',
    () => requestSettled,
    async () => {
      waits++;
      requestSettled = true;
      return true;
    }
  );

  assert.equal(contextLength, 32768);
  assert.equal(checks, 2);
  assert.equal(waits, 1);
});

for (const [before, after] of [
  [32768, 65536],
  [65536, 32768]
]) {
  test(`confirms a ${formatContextLength(before)} runner changed to ${formatContextLength(after)} after chat readiness`, async () => {
    let requestSettled = false;
    let checks = 0;
    const contextLength = await waitForMachineContextLength(
      async () => {
        checks++;
        return [{ name: 'gemma3', context_length: checks === 1 ? before : after }];
      },
      'gemma3',
      () => requestSettled,
      async () => {
        requestSettled = true;
        return true;
      }
    );

    assert.equal(contextLength, after);
    assert.equal(checks, 2);
  });
}

test('checks once more when the chat response arrives during a process lookup', async () => {
  let requestSettled = false;
  let checks = 0;
  const contextLength = await waitForMachineContextLength(
    async () => {
      checks++;
      if (checks === 1) {
        requestSettled = true;
        return [{ model: 'gemma3:latest', context_length: 32768 }];
      }
      return [{ model: 'gemma3:latest', context_length: 65536 }];
    },
    'gemma3',
    () => requestSettled,
    async () => {
      assert.fail('should retry immediately after the response arrives');
    }
  );

  assert.equal(contextLength, 65536);
  assert.equal(checks, 2);
});

test('stops polling when the request has settled without a local process', async () => {
  let waits = 0;
  const contextLength = await waitForMachineContextLength(
    async () => [],
    'gemma3',
    () => true,
    async () => {
      waits++;
      return true;
    }
  );

  assert.equal(contextLength, undefined);
  assert.equal(waits, 0);
});

test('stops polling when the next context check is cancelled', async () => {
  let checks = 0;
  let waits = 0;
  const contextLength = await waitForMachineContextLength(
    async () => {
      checks++;
      return [];
    },
    'gemma3',
    () => false,
    async () => {
      waits++;
      return false;
    }
  );

  assert.equal(contextLength, undefined);
  assert.equal(checks, 1);
  assert.equal(waits, 1);
});

test('releases a ready chat stream when the machine context check does not respond', async () => {
  let cancelled = false;
  const neverSettles = new Promise(() => {});

  await waitForMachineContextCheckBeforeStreaming(
    neverSettles,
    async () => {},
    () => { cancelled = true; }
  );

  assert.equal(cancelled, true);
});

test('does not time out a machine context check that finishes first', async () => {
  let releaseTimeout;
  let cancelled = false;
  const timeout = new Promise(resolve => { releaseTimeout = resolve; });

  await waitForMachineContextCheckBeforeStreaming(
    Promise.resolve(),
    () => timeout,
    () => { cancelled = true; }
  );
  releaseTimeout();
  await Promise.resolve();

  assert.equal(cancelled, false);
});

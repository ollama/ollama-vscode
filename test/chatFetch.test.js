const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const Module = require('node:module');
const test = require('node:test');

const { createChatFetch, trustedCACertificates } = require('../out/chatFetch');

const testCA = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUXIndq+5WqQ2X9IChvfNY7XoZ3JowDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOT2xsYW1hIFRlc3QgQ0EwHhcNMjYwODA1MTYyNDA5WhcN
MzYwODAyMTYyNDA5WjAZMRcwFQYDVQQDDA5PbGxhbWEgVGVzdCBDQTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAOe6Lr157sdZiIP/7bMsGYCbTSO8L90c
PDcgvkXG7ZQKzMmt1w9avw0iLQAvOdB2ZgluVmlrK71DObeB/1Ico9ilIjuKWo6M
w8eF16UXwV7xTAALSMkCwRIcQ5+OjQB98egynY+KLZUQ/AK9hzk546Rw8Z8PGHg8
ldv990rbD4QjZxQXULqEYE5AOgEkMEJpieVTag2zLW9Ono3ip+VrZRwIXHSLCKYf
Ji39wSUo8BxX7nYvlHeLfOb+uwLYyv4IM2oD6RNOXnBFMIGz4x35yX2u+D7gBKWW
o9CjqIcdkz1MB2ElaOA9S0ydVhcI96dc0jkhgqo9ZVomtYgapFNFD50CAwEAAaNT
MFEwHQYDVR0OBBYEFL8+0UdEYnmFU4ASurXlr7OOpc/7MB8GA1UdIwQYMBaAFL8+
0UdEYnmFU4ASurXlr7OOpc/7MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAEgogDlSLiK80GamWDyiMFonTQSdAlNvVKdP7+ab/oQA92qhFKEPVGn2
w9TUoLQV1tmFSo+pN9v+zaQDmlQMAwFdtJUgFdVS1Vs2suY0Uz2RntIhyyjBUXKQ
2L7DeyBGOgXj4QOtsJSQJboGrXZlbswJ8qSh8pHl5NEGhfwSwsnAzDkwb2TF8gKy
ndisx5UUeAkG5IrO3MnEEbwxggDaHlIEBRDN2HuSv3tbknAjyKpyV78QQUlSzDQx
tnr1xn2MXDk4fdtvELRsfhGUDp6+3U38St7gsJWGyNZDkx41Y9bHoJNYwTXXOW08
oCWKPKV7cc2NjAAjcXSdW+PWg3JN81E=
-----END CERTIFICATE-----`;

const testServerCertificate = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIURyb7VC+9WSIxiaC/tq6IisaecrkwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOT2xsYW1hIFRlc3QgQ0EwHhcNMjYwODA1MTYyNDA5WhcN
MzYwODAyMTYyNDA5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQC338jplAyAG5AeOwULBBD8xBvPNbIt5U7Nd2GM
cvXqsrFN1tqWG3rvSFmjosfxq/y0rmHKkEFnhrLgXD8rdtFjDhdHlpixNuAjZZDr
y5mNyN9VWyZUelHowZHJD9QaAC8nfZYyp1quMmKKnRWlSvhIo8sn5SWtEF0Nb+BE
pDVm6TtKnfPdQmYwhkVLooQoRxzTJKLVgTHPMpV2Ul5D270JLMMTweNFPfQG+H0M
A5GY6kFnh3ttwZPBxMA/3HMQrNG/f6W13Fvjy7yJJVAZT20p9C2eIwtbLGqIYu+m
2eSADim9yCP7yYyWtJr01YEjj24B/QaaN3hyBNM1+9IQFzSrAgMBAAGjaDBmMA8G
A1UdEQQIMAaHBH8AAAEwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFBMn
tKN5Qm+y+hf3bFI5akMK87w2MB8GA1UdIwQYMBaAFL8+0UdEYnmFU4ASurXlr7OO
pc/7MA0GCSqGSIb3DQEBCwUAA4IBAQCfcbJ8g6FY8UI9Q1QJVf4BvtfAnxuTejnn
rAg86HjuVCX7ljHf6jpxzkDwuaBrunTpFKVHqlCblJJqx1FnV8xUpSGP8vRxEKfK
abXJZKazaiMEHl4YLGfpVDS6iaxaXc6RfbYB9GXfXMbXT5LO2Abu5x83+cH1dyct
Ju/neflpXkm6tOUhuSf29L8wVGUwpWRwiEe466pYLd+tZGnaN2gL58SBxpgNuF39
xLytYiXIfn8SDPXmQbfqVhG+Lih0wJ+6ro1TWt0r0xOrWObXqT/WOLURM+LQ+pfm
7VrWdKM1nTgqMz7sWImMogXdDWkf+Guz0VlIhkutOdma4ctTBhwm
-----END CERTIFICATE-----`;

const testServerKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC338jplAyAG5Ae
OwULBBD8xBvPNbIt5U7Nd2GMcvXqsrFN1tqWG3rvSFmjosfxq/y0rmHKkEFnhrLg
XD8rdtFjDhdHlpixNuAjZZDry5mNyN9VWyZUelHowZHJD9QaAC8nfZYyp1quMmKK
nRWlSvhIo8sn5SWtEF0Nb+BEpDVm6TtKnfPdQmYwhkVLooQoRxzTJKLVgTHPMpV2
Ul5D270JLMMTweNFPfQG+H0MA5GY6kFnh3ttwZPBxMA/3HMQrNG/f6W13Fvjy7yJ
JVAZT20p9C2eIwtbLGqIYu+m2eSADim9yCP7yYyWtJr01YEjj24B/QaaN3hyBNM1
+9IQFzSrAgMBAAECggEADIexd0lheLFoJsc61r9WMQNkKcCs/besoQ/Lk/iZjX7T
2kwT5TrGK9wwT5heK7fepqljfJxL+LQTKHrgyyNzrV5ec8Btc1Yb/A2FzKu5MRJJ
NdXaTNNxFX1rY9oyR/tPO0+xlo4U/d3tHSkLOpJbTQfsZjGVWa/Nx4aiL8tI4FRS
5YceW3QTmgeY9qMN5rV/CiYbKvEyrA9IJjapcd36TVyLzDwb50gUT1XFAsuPL6D1
O4yYNfubHPmxavK1u72GIwHwb+jeIlKAdgbTWRAXUtL5qrQp+z1WOr9yn+mbUq5g
3hDcQdG9DTVn9HSltSMUVDUMtNn688ft+IF/4RpWIQKBgQDbxD77ku6zjxROrgH4
A1JNuuNzWoB3QUZWqXaH79CKY+Gt22b6Ohbs00E2gHNQIf8xZhu4E7qLAHor0Fh5
LnB81VVAYqklA1EVp9UezBxQgatzoMTIDpZiMuXbN7aBUtbQOmoF3eoks3ndYgmu
mpLrruGhkUK8JBt3cogFbi+7iQKBgQDWMJ3NJsMvliQthEowjrFMTmphv8StabKu
m2aTdeWVvGcaraQo72jbcQu/k6uoHg+Vpr9aMKbI+svgLbPbtOEVBw0xg7v7bE7t
eHR0t/chiNrBOw5ucII6xb5ZJH3ipOvwlqS4RhzrcdIA/fQq8B7u0ZhN4fAL4YW/
P98VgvAdkwKBgHq4swcfPObOTmPFbdoGWM6JP3xqHHT74YCBb2xnscemER9Z9r5i
8+xZ5/+8aShlY7E9ONtpQPFgWdjfppg9I5nCM7IZpiTCHmR+bVeeWW1ni8utClZB
Nx8tFwh8qxC6prRu+ke+bYMDKllC5u826DZuWRc1G9QeQaxJK8YEiukpAoGAVnYD
jSfDjLcH3ZPUOuuu6EWTLegyZWoQZel3K7lgtuP5nsxPQvL5mfN1MZ1ToqaX1eoc
vjR7bw/GMrVgMCVA4rMZAU7TGDftWHDSWbdVPCU5YN0NA0nJWB4wq11Or6mxUEoP
Lg+nZudoRVw+LwMFCZRz7aRxuOoNilknHVDgyp8CgYBtHV/I+P4hVg1Ki1PBEQ79
p94mnHemnH4ai5Y3pKeucfRxDZ/fbrtKh/d2nHYYwmOFE1SLY2CgR4vbAwrtmGDb
Z4elZa9uum8yiIIHyUMePO6I4A1RSJA4BB/Bz4DdKjcqqRLuIThIT+VmCY5e4ag5
tAYdMFxClI/GAUet7Rri2g==
-----END PRIVATE KEY-----`;

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

test('waits for delayed response headers within the chat timeout', async () => {
  await withServer((request, response) => {
    request.resume();
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('{"done":true}\n');
    }, 75);
  }, async url => {
    const transport = createChatFetch(1000);
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

test('combines default and operating system certificates', () => {
  const certificates = trustedCACertificates(type => type === 'default'
    ? ['default CA', 'shared CA']
    : ['system CA', 'shared CA']);
  assert.deepEqual(certificates, ['default CA', 'shared CA', 'system CA']);
});

test('uses the system trust store to stream chat over HTTPS with a private CA', async () => {
  let finishResponse;
  const firstChunkRead = new Promise(resolve => { finishResponse = resolve; });
  await withHttpsServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write('{"message":{"content":"hello"},"done":false}\n');
    void firstChunkRead.then(() => response.end('{"done":true}\n'));
  }, async url => {
    const untrusted = createChatFetch(1000, () => []);
    try {
      await assert.rejects(
        untrusted.fetch(`${url}/api/chat`),
        error => error.cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
      );
    } finally {
      untrusted.dispose();
    }

    const trusted = createChatFetch(1000, type => type === 'system' ? [testCA] : []);
    try {
      const response = await trusted.fetch(`${url}/api/chat`, {
        method: 'POST',
        body: '{"stream":true}'
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const first = await withTimeout(reader.read(), 1000);
      assert.equal(first.done, false);
      assert.match(decoder.decode(first.value, { stream: true }), /"hello"/);

      finishResponse();
      let remainder = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        remainder += decoder.decode(value, { stream: true });
      }
      remainder += decoder.decode();
      assert.match(remainder, /"done":true/);
    } finally {
      trusted.dispose();
    }
  });
});

test('enforces a finite response header timeout', async () => {
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
    const transport = createChatFetch(1000);
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

async function withHttpsServer(handler, run) {
  const server = https.createServer({
    cert: testServerCertificate,
    key: testServerKey
  }, handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  try {
    await run(`https://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

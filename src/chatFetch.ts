import {
  Agent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit
} from 'undici';

interface ChatFetch {
  readonly fetch: typeof globalThis.fetch;
  dispose(): void;
}

export function createChatFetch(headersTimeout = 0): ChatFetch {
  const dispatcher = new Agent({
    headersTimeout
  });
  let disposed = false;

  return {
    fetch: async (input, init) => undiciFetch(
      input as unknown as UndiciRequestInfo,
      {
        ...(init as unknown as UndiciRequestInit | undefined),
        dispatcher
      }
    ) as unknown as Response,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      void dispatcher.destroy().catch(() => undefined);
    }
  };
}

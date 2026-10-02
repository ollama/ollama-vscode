import {
  Agent,
  fetch as undiciFetch,
  type RequestInfo as UndiciRequestInfo,
  type RequestInit as UndiciRequestInit
} from 'undici';
import { getCACertificates } from 'node:tls';

interface ChatFetch {
  readonly fetch: typeof globalThis.fetch;
  dispose(): void;
}

export function trustedCACertificates(
  loadCertificates: typeof getCACertificates = getCACertificates
): string[] {
  return [...new Set([
    ...loadCertificates('default'),
    ...loadCertificates('system')
  ])];
}

export function createChatFetch(
  headersTimeout: number,
  loadCertificates: typeof getCACertificates = getCACertificates
): ChatFetch {
  const dispatcher = new Agent({
    headersTimeout,
    connect: { ca: trustedCACertificates(loadCertificates) }
  });
  let disposed = false;
  // The Ollama SDK keeps only the body until iteration starts. Keep its Response
  // alive so Undici's finalizer cannot cancel that unread stream.
  const responses = new Set<Response>();

  return {
    fetch: async (input, init) => {
      const response = await undiciFetch(
        input as unknown as UndiciRequestInfo,
        {
          ...(init as unknown as UndiciRequestInit | undefined),
          dispatcher
        }
      ) as unknown as Response;
      responses.add(response);
      return response;
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      responses.clear();
      void dispatcher.destroy().catch(() => undefined);
    }
  };
}

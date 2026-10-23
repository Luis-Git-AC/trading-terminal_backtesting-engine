import { UpstreamError } from '../../ingest/exchange/errors.js';

/** Tope del fichero entero: el real pesa ~0,4 MB, y es dato no confiable (como el zip de F7b-T3). */
export const MAX_BYTES = 32 * 1024 * 1024;
/** Una fila real son ~1,2 kB; sin tope, un fichero sin saltos de linea seria memoria infinita. */
export const MAX_LINE_BYTES = 64 * 1024;

export interface StreamResponse {
  readonly status: number;
  /**
   * Cuerpo por trozos. `fetch` de Node lo da como `AsyncIterable`; se acepta tambien el sincrono
   * porque `for await` consume los dos y a un test le basta un generador normal.
   */
  readonly body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
}

export type StreamFetch = (url: string) => Promise<StreamResponse>;

export interface CftcClientOptions {
  url: string;
  fetch: StreamFetch;
}

export interface CftcClient {
  /** Las filas del informe, de una en una: el fichero no se acumula en memoria. */
  streamLines(): AsyncIterable<string>;
}

export function createCftcClient(options: CftcClientOptions): CftcClient {
  async function* streamLines(): AsyncIterable<string> {
    const response = await options.fetch(options.url);

    if (response.status !== 200) {
      throw new UpstreamError(`la CFTC respondio ${response.status}`, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    if (response.body === null) {
      throw new UpstreamError('la CFTC respondio sin cuerpo', { status: response.status });
    }

    const decoder = new TextDecoder('utf-8');
    let pending = '';
    let bytes = 0;

    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BYTES) {
        throw new UpstreamError(`el informe de la CFTC pasa de ${MAX_BYTES} bytes`, {
          status: response.status,
        });
      }

      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        yield pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }

      if (pending.length > MAX_LINE_BYTES) {
        throw new UpstreamError(`una fila de la CFTC pasa de ${MAX_LINE_BYTES} bytes`, {
          status: response.status,
        });
      }
    }

    pending += decoder.decode();
    if (pending.trim().length > 0) yield pending.replace(/\r$/, '');
  }

  return { streamLines };
}

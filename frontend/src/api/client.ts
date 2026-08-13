import type { ZodType } from 'zod';
import { ApiError, parseErrorEnvelope } from '@/api/errors';
import { trustUnchecked } from '@/api/unchecked';

export type QueryValue = string | number | boolean | undefined;

export interface SendOptions {
  readonly path: string;
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface RequestOptions<T> extends SendOptions {
  readonly schema: ZodType<T>;
}

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly validate?: boolean;
}

export interface ApiClient {
  request<T>(options: RequestOptions<T>): Promise<T>;
  requestVoid(options: SendOptions): Promise<void>;
  readonly baseUrl: string;
}

export function resolveBaseUrl(raw: string | undefined): string {
  const value = raw ?? '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }

  const qs = search.toString();
  return `${baseUrl}/api${path}${qs === '' ? '' : `?${qs}`}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (text === '') {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw ApiError.malformed(
      `El API respondio algo que no es JSON (HTTP ${response.status}).`,
      cause,
    );
  }
}

function contractFailure(
  path: string,
  issues: readonly { path: PropertyKey[]; message: string }[],
) {
  const where = issues
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join(' · ');
  return ApiError.malformed(`La respuesta de ${path} no cumple el contrato — ${where}`);
}

export function createApiClient(clientOptions: ApiClientOptions = {}): ApiClient {
  const baseUrl = resolveBaseUrl(clientOptions.baseUrl ?? import.meta.env.VITE_API_URL);
  const doFetch = clientOptions.fetch ?? ((...args) => globalThis.fetch(...args));
  const validate = clientOptions.validate ?? import.meta.env.DEV;

  async function send(options: SendOptions): Promise<Response> {
    const url = buildUrl(baseUrl, options.path, options.query);
    const hasBody = options.body !== undefined;

    let response: Response;
    try {
      response = await doFetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw cause;
      }
      throw ApiError.network(cause);
    }

    if (!response.ok) {
      throw parseErrorEnvelope(await readJson(response), response.status);
    }

    return response;
  }

  return {
    baseUrl,

    async request<T>(options: RequestOptions<T>): Promise<T> {
      const payload = await readJson(await send(options));

      if (!validate) {
        return trustUnchecked<T>(payload);
      }

      const parsed = options.schema.safeParse(payload);

      if (!parsed.success) {
        throw contractFailure(options.path, parsed.error.issues);
      }

      return parsed.data;
    },

    async requestVoid(options: SendOptions): Promise<void> {
      await send(options);
    },
  };
}

export const apiClient = createApiClient();

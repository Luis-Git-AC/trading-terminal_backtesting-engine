import type {
  SocketFactory,
  SocketHandlers,
  SocketLike,
} from '../ingest/ws/resilient-socket.js';

export const FAKE_ADAPTER_LISTENERS = 4;

export interface FakeSocket extends SocketLike {
  readonly url: string;
  readonly sent: string[];
  readonly terminated: boolean;
  readonly closeCalls: number;
  emitOpen(): void;
  emitMessage(data: string): void;
  emitError(error: Error): void;
  emitClose(code?: number, reason?: string): void;
}

export interface FakeSocketFactory {
  readonly factory: SocketFactory;
  readonly created: FakeSocket[];
  last(): FakeSocket;
}

export function createFakeSocketFactory(
  options: { closeOnRequest?: boolean } = {},
): FakeSocketFactory {
  const closeOnRequest = options.closeOnRequest ?? true;
  const created: FakeSocket[] = [];

  const factory: SocketFactory = (url, handlers: SocketHandlers) => {
    let live = true;
    let listeners = FAKE_ADAPTER_LISTENERS;
    let terminated = false;
    let closeCalls = 0;
    const sent: string[] = [];

    const fake: FakeSocket = {
      url,
      sent,
      get terminated() {
        return terminated;
      },
      get closeCalls() {
        return closeCalls;
      },
      get listenerCount() {
        return listeners;
      },
      send(message) {
        sent.push(message);
      },
      close() {
        closeCalls += 1;
        if (closeOnRequest) fake.emitClose(1000, 'normal');
      },
      terminate() {
        terminated = true;
      },
      dispose() {
        live = false;
        listeners = 0;
      },
      emitOpen() {
        if (live) handlers.open();
      },
      emitMessage(data) {
        if (live) handlers.message(data);
      },
      emitError(error) {
        if (live) handlers.error(error);
      },
      emitClose(code = 1006, reason = '') {
        if (!live) return;
        live = false;
        handlers.close(code, reason);
      },
    };

    created.push(fake);
    return fake;
  };

  return {
    factory,
    created,
    last() {
      const socket = created.at(-1);
      if (socket === undefined) throw new Error('no se ha creado ningun socket');
      return socket;
    },
  };
}

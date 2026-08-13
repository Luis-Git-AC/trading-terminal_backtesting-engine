import { SSE_CLOSED, SSE_CONNECTING, SSE_OPEN, type SseConnection } from '@/api/event-source';

type Listener = (event: MessageEvent<string>) => void;

export class FakeEventSource implements SseConnection {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static get openCount(): number {
    return FakeEventSource.instances.length;
  }

  static last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1);
    if (instance === undefined) {
      throw new Error('No se ha abierto ningun EventSource');
    }
    return instance;
  }

  readonly url: string;
  readyState = SSE_CONNECTING;
  closeCalls = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = SSE_CLOSED;
  }

  open(): void {
    this.readyState = SSE_OPEN;
    this.onopen?.(new Event('open'));
  }

  emit(type: string, payload: unknown): void {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: raw }));
    }
  }

  dropRetrying(): void {
    this.readyState = SSE_CONNECTING;
    this.onerror?.(new Event('error'));
  }

  dropGivingUp(): void {
    this.readyState = SSE_CLOSED;
    this.onerror?.(new Event('error'));
  }
}

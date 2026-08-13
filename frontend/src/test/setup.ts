import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '@/test/msw/server';

class StubResizeObserver implements ResizeObserver {
  observe(): void {
    return;
  }
  unobserve(): void {
    return;
  }
  disconnect(): void {
    return;
  }
}

globalThis.ResizeObserver ??= StubResizeObserver;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

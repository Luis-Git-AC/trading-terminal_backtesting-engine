import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ConnectionState } from '@/hooks/useEventSource';

export interface LiveStatus {
  readonly candleStream: ConnectionState;
  readonly setCandleStream: (state: ConnectionState) => void;
}

const DETACHED: LiveStatus = { candleStream: 'disconnected', setCandleStream: () => undefined };

const LiveStatusContext = createContext<LiveStatus | null>(null);

export function LiveStatusProvider({ children }: { children: ReactNode }) {
  const [candleStream, setCandleStream] = useState<ConnectionState>('disconnected');

  const value = useMemo<LiveStatus>(() => ({ candleStream, setCandleStream }), [candleStream]);

  return <LiveStatusContext.Provider value={value}>{children}</LiveStatusContext.Provider>;
}

export function useLiveStatus(): LiveStatus {
  return useContext(LiveStatusContext) ?? DETACHED;
}

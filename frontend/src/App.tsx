import { Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Runs } from '@/pages/Runs';
import { Terminal } from '@/pages/Terminal';
import { LiveStatusProvider } from '@/state/live-status';
import { MarketSelectionProvider } from '@/state/market-selection';
import { ThemeProvider } from '@/state/theme';

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <MarketSelectionProvider>
          <LiveStatusProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Terminal />} />
                <Route path="runs" element={<Runs />} />
              </Route>
            </Routes>
          </LiveStatusProvider>
        </MarketSelectionProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

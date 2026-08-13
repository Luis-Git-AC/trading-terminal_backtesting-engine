import { Route, Routes } from 'react-router';
import { AppShell } from '@/components/AppShell/AppShell';
import { Runs } from '@/pages/Runs';
import { Terminal } from '@/pages/Terminal';
import { MarketSelectionProvider } from '@/state/market-selection';
import { ThemeProvider } from '@/state/theme';

export function App() {
  return (
    <ThemeProvider>
      <MarketSelectionProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Terminal />} />
            <Route path="runs" element={<Runs />} />
          </Route>
        </Routes>
      </MarketSelectionProvider>
    </ThemeProvider>
  );
}

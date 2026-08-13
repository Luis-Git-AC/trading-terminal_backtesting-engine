import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { App } from '@/App';
import { createQueryClient } from '@/api/query-client';
import { applyTheme, initialResolvedTheme } from '@/state/theme';
import '@/styles/tokens.css';
import '@/styles/global.css';

const container = document.getElementById('root');

if (container === null) {
  throw new Error('No existe el nodo #root en index.html');
}

applyTheme(initialResolvedTheme());

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

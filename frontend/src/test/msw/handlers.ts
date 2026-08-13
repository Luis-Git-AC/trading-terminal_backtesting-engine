import { HttpResponse, http, type HttpHandler } from 'msw';
import { ERROR_STATUS, type ErrorCode, type ErrorDetail } from '@tt/shared';
import { apiClient } from '@/api/client';
import * as fixtures from '@/test/msw/fixtures';

export const API_BASE = apiClient.baseUrl;

function url(path: string): string {
  return `${API_BASE}/api${path}`;
}

export function errorResponse(code: ErrorCode, message: string, details?: readonly ErrorDetail[]) {
  return HttpResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status: ERROR_STATUS[code] },
  );
}

export const handlers: HttpHandler[] = [
  http.get(url('/health'), () => HttpResponse.json(fixtures.health)),

  http.get(url('/markets'), () => HttpResponse.json(fixtures.markets)),

  http.get(url('/markets/:symbol/coverage'), ({ params, request }) => {
    const timeframe = new URL(request.url).searchParams.get('timeframe');
    return HttpResponse.json({
      ...fixtures.coverage,
      symbol: String(params.symbol),
      timeframe: timeframe ?? fixtures.coverage.timeframe,
    });
  }),

  http.get(url('/candles'), ({ request }) => {
    const query = new URL(request.url).searchParams;
    return HttpResponse.json({
      ...fixtures.candles,
      symbol: query.get('symbol') ?? fixtures.candles.symbol,
      timeframe: query.get('timeframe') ?? fixtures.candles.timeframe,
    });
  }),

  http.get(url('/strategies'), () => HttpResponse.json(fixtures.strategies)),

  http.post(url('/backtests'), () => HttpResponse.json(fixtures.created, { status: 202 })),

  http.get(url('/backtests'), () => HttpResponse.json(fixtures.runs)),

  http.get(url('/backtests/:id/trades'), () => HttpResponse.json(fixtures.trades)),

  http.get(url('/backtests/:id/equity'), () => HttpResponse.json(fixtures.equity)),

  http.post(url('/backtests/:id/cancel'), ({ params }) =>
    HttpResponse.json({ runId: String(params.id), status: 'cancelled' }),
  ),

  http.delete(url('/backtests/:id'), () => new HttpResponse(null, { status: 204 })),

  http.get(url('/backtests/:id'), ({ params }) => {
    if (params.id !== fixtures.RUN_ID) {
      return errorResponse('NOT_FOUND', `No existe el run ${String(params.id)}`);
    }
    return HttpResponse.json(fixtures.run);
  }),
];

/** Tasa de funding ya liquidada. `intervalHours` no es decorativo: Binance liquida cada 4 u 8 h e Hyperliquid cada hora. */
export interface FundingRate {
  t: number;
  rate: number;
  intervalHours: number;
}

/** Open interest con el `ts` del exchange. `quote` es null cuando la fuente solo da el nocional en base. */
export interface OpenInterestPoint {
  t: number;
  base: number;
  quote: number | null;
}

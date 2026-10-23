import { assetClassOf, type AssetClass } from '@tt/shared';

export type MacroUnit = 'percent' | 'index' | 'kbarrels' | 'usd';

export interface MacroSeriesSpec {
  readonly seriesId: string;
  /** Explicito para que el endpoint no tenga que desambiguar la serie. */
  readonly source: string;
  readonly label: string;
  readonly unit: MacroUnit;
}

/**
 * Que mirar segun lo que se este operando: tipos reales y dolar para el oro, inventarios para el
 * petroleo, stablecoins y dominancia para crypto. Las series son las que recogen las fuentes de
 * F9-T3 a F9-T6, con su `source` para no depender de que el id sea unico.
 */
export const MACRO_SERIES_BY_CLASS: Readonly<Record<AssetClass, readonly MacroSeriesSpec[]>> = {
  metals: [
    { seriesId: 'DFII10', source: 'fred', label: 'Tipo real 10 anos', unit: 'percent' },
    { seriesId: 'DTWEXBGS', source: 'fred', label: 'Indice del dolar', unit: 'index' },
  ],
  energy: [
    {
      seriesId: 'WCESTUS1',
      source: 'eia',
      label: 'Inventarios de crudo (EEUU)',
      unit: 'kbarrels',
    },
    { seriesId: 'wti-net-noncommercial', source: 'cftc', label: 'Neto no comercial WTI', unit: 'index' },
  ],
  crypto: [
    {
      seriesId: 'stablecoins-circulating-usd',
      source: 'defillama',
      label: 'Stablecoins en circulacion',
      unit: 'usd',
    },
    { seriesId: 'dominance-btc', source: 'coingecko', label: 'Dominancia BTC', unit: 'percent' },
  ],
};

/**
 * Etiquetas de evento que importan a cada clase de activo. El endpoint las trata como un OR, asi
 * que el oro ve su propio COT y ademas el calendario macro y del dolar.
 */
export const EVENT_TAGS_BY_CLASS: Readonly<Record<AssetClass, readonly string[]>> = {
  metals: ['gold', 'silver', 'macro', 'usd'],
  energy: ['oil', 'macro'],
  crypto: ['macro', 'usd'],
};

/** Las series macro son diarias o semanales: una ventana de velas de unas horas no daria ni un punto. */
export const MACRO_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;

export function macroSeriesFor(symbol: string): readonly MacroSeriesSpec[] {
  return MACRO_SERIES_BY_CLASS[assetClassOf(symbol)];
}

export function eventTagsFor(symbol: string): readonly string[] {
  return EVENT_TAGS_BY_CLASS[assetClassOf(symbol)];
}

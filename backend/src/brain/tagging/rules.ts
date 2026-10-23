export const ASSETS = ['gold', 'silver', 'oil', 'btc', 'eth', 'macro'] as const;

export type Asset = (typeof ASSETS)[number];

export interface TagRule {
  /**
   * Identificador estable y versionado. Al cambiar los terminos de una regla se sube su version
   * (`-v2`): los documentos guardan el `rule_id` con el que se etiquetaron, asi que el reetiquetado
   * sabe que borrar y las etiquetas de las demas reglas no se tocan.
   */
  readonly id: string;
  readonly asset: Asset;
  /** Terminos en minusculas. La coincidencia es por palabra completa (ver `tagDocument`). */
  readonly terms: readonly string[];
}

/**
 * Las reglas son datos, no codigo: un diccionario de terminos y tickers por activo. Sin LLM.
 *
 * Nombres y tickers van en reglas separadas a proposito: un ticker se equivoca de otra manera que
 * un nombre, y separarlos permite retirar solo la mitad que falle sin perder la otra.
 */
export const RULES: readonly TagRule[] = Object.freeze([
  { id: 'gold-nombres-v1', asset: 'gold', terms: ['gold', 'bullion'] },
  { id: 'gold-tickers-v1', asset: 'gold', terms: ['xau', 'xauusd', 'gld'] },
  { id: 'silver-nombres-v1', asset: 'silver', terms: ['silver'] },
  { id: 'silver-tickers-v1', asset: 'silver', terms: ['xag', 'xagusd', 'slv'] },
  {
    id: 'oil-nombres-v1',
    asset: 'oil',
    terms: [
      'oil',
      'crude',
      'petroleum',
      'opec',
      'brent',
      'wti',
      'gasoline',
      'distillate',
      'distillates',
      'refinery',
    ],
  },
  { id: 'btc-nombres-v1', asset: 'btc', terms: ['bitcoin'] },
  { id: 'btc-tickers-v1', asset: 'btc', terms: ['btc', 'btcusdt', 'xbt'] },
  { id: 'eth-nombres-v1', asset: 'eth', terms: ['ethereum', 'ether'] },
  { id: 'eth-tickers-v1', asset: 'eth', terms: ['eth', 'ethusdt'] },
  {
    id: 'macro-nombres-v1',
    asset: 'macro',
    // `fed` a secas queda fuera: «fed up» lo activaria y la palabra completa no salva ese caso.
    terms: [
      'inflation',
      'cpi',
      'fomc',
      'federal reserve',
      'interest rate',
      'interest rates',
      'rate cut',
      'rate hike',
      'treasury yield',
      'treasury yields',
      'nonfarm payrolls',
      'unemployment rate',
      'recession',
    ],
  },
]);

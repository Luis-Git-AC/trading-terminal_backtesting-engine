export interface FeedConfig {
  /** Va a la columna `source` de `raw_documents`: es la clave con la que se filtra despues. */
  readonly id: string;
  readonly url: string;
  /** Idioma por defecto cuando el feed no declara el suyo. */
  readonly lang: string;
}

/**
 * Lista versionada a proposito: son datos de configuracion que cambian con el codigo que los lee,
 * no secretos ni ajustes por entorno. Medios de crypto y materias primas, mas las notas de prensa
 * de la Fed y la EIA, que son la fuente primaria de lo que mueve el macro.
 */
export const DEFAULT_FEEDS: readonly FeedConfig[] = Object.freeze([
  { id: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', lang: 'en' },
  { id: 'cointelegraph', url: 'https://cointelegraph.com/rss', lang: 'en' },
  { id: 'mining-com', url: 'https://www.mining.com/feed/', lang: 'en' },
  { id: 'oilprice', url: 'https://oilprice.com/rss/main', lang: 'en' },
  { id: 'fed-press', url: 'https://www.federalreserve.gov/feeds/press_all.xml', lang: 'en' },
  { id: 'eia-press', url: 'https://www.eia.gov/rss/press_rss.xml', lang: 'en' },
]);

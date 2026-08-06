/**
 * `@tt/shared` — fuente de verdad de los tipos que cruzan la frontera backend <-> frontend.
 *
 * El contenido real (Timeframe, Candle, codigos de error, esquemas Zod del contrato de API)
 * llega en F1-T5 y se amplia en F4-T8. Ver docs/03-API-CONTRACT.md.
 */

/** Version del paquete compartido. Sirve de canario de que el enlace del workspace funciona. */
export const SHARED_VERSION = '0.1.0' as const;

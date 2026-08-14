# Fixture de velas del entorno E2E

`candles.json` es el dataset con el que arranca el stack E2E. **Son datos reales de Bitget**, no
sintéticos: `docs/05-TESTING.md §Datos y fixtures` pide exactamente esto — «un fixture real pequeño
(p. ej. 2.000 velas 15m de BTCUSDT descargadas una vez y commiteadas como JSON) para tests de
regresión de extremo a extremo».

Durante el E2E **nadie llama a Bitget**: la descarga ocurrió una sola vez, aquí, y lo que se commitea
es el resultado. El ingestor se sustituye por `e2e/emitter.ts` (ver más abajo).

## Procedencia

| Campo                            | Valor                                                          |
| -------------------------------- | -------------------------------------------------------------- |
| Exchange                         | `bitget`, `productType=USDT-FUTURES`                           |
| Endpoint original                | `GET https://api.bitget.com/api/v2/mix/market/history-candles` |
| Cómo se descargó                 | `npm run backfill` sobre la BD local de desarrollo (fase 1)    |
| Cuándo se extrajo a este fichero | **2026-08-14**, con una consulta directa a la BD de desarrollo |
| Edición                          | **ninguna**. Los valores son los que devolvió el exchange      |

Los precios se serializan como `float8`, que es exactamente lo que ve la aplicación: el repositorio
de velas hace `Number(...)` sobre el `numeric` de Postgres al leerlo.

## Contenido

| Serie         | Velas | Desde (UTC)      | Hasta (UTC)      | Huecos |
| ------------- | ----- | ---------------- | ---------------- | ------ |
| `BTCUSDT 15m` | 2.000 | 2026-07-01 00:00 | 2026-07-21 19:45 | 0      |
| `BTCUSDT 1m`  | 5.000 | 2026-07-18 08:26 | 2026-07-21 19:45 | 0      |

Las dos series **terminan en el mismo instante**, así que cambiar de timeframe en la interfaz enseña
el mismo tramo de mercado. Las dos son contiguas: `e2e/fixtures/seed.ts` lo verifica al cargarlas y
revienta con `FixtureError` si aparece un hueco, un `ts` desalineado o una vela incoherente.

## Formato

```jsonc
{
  "exchange": "bitget",
  "columns": ["t", "o", "h", "l", "c", "v"], // orden de las tuplas
  "series": [{ "symbol": "BTCUSDT", "timeframe": "15m", "stepMs": 900000, "bars": 2000,
              "candles": [[1782864000000, 58608.3, 58726.1, 58587.8, 58629.1, 220.8595], ...] }]
}
```

Tuplas en vez de objetos para que 7.000 velas ocupen ~435 kB en vez de ~1 MB. El fichero está en
`.prettierignore`: formatearlo lo convertiría en 42.000 líneas sin ganar nada.

## Rango fijo, no relativo a "ahora"

El fixture cubre un rango **histórico y fijo**. Esto es lo que hace que el seed sea determinista: dos
ejecuciones en días distintos escriben exactamente las mismas velas.

Que el rango esté en el pasado no rompe la interfaz: `useCandleWindow` ancla la ventana del gráfico
en `coverage.to` (la vela más nueva que hay en la base de datos), no en el reloj del navegador.

## El emisor sustituye al ingestor

`e2e/emitter.ts` continúa la serie de `1m` desde la última vela del fixture y publica los ticks en
Redis igual que haría el ingestor, en un reloj acelerado. No abre ningún socket contra el exchange.
Las velas que emite se derivan del propio fixture con el PRNG sembrado del motor, así que también son
deterministas.

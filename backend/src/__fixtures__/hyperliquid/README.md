# Fixtures de Hyperliquid

Payloads usados por los tests del adaptador. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

Capturados el **2026-10-22** contra `https://api.hyperliquid.xyz`, endpoint `POST /info` con
`{type: 'candleSnapshot', req: {coin, interval, startTime, endTime}}`. Datos públicos: **sin API key
y sin firma**. Los ficheros reales están sin editar; su procedencia vive aquí.

| Fichero | Origen | Petición | Qué demuestra |
|---|---|---|---|
| `candle-snapshot-15m-ok.json` | **real** | `coin=BTC&interval=15m`, última hora y cuarto | 6 velas de 15m como **objetos** `{t, T, s, i, o, h, l, c, v, n}`, con los precios en string y los tiempos numéricos. El símbolo es `BTC`, sin par |
| `candle-snapshot-empty.json` | **real** | `startTime=1420070400000` (2015) | Fuera del histórico que guarda Hyperliquid: `[]` con HTTP 200. No es un error, es el límite de las 5000 velas |
| `unknown-coin.json` | **real** | `coin=NOPE` | Un `coin` que no existe devuelve **`null`** (y HTTP 500), no un array vacío: hay que distinguirlo |
| `error-bad-interval.txt` | **real** | `interval=3x` | HTTP 422 con un **cuerpo de texto plano**, no JSON: `Failed to deserialize the JSON body into the target type` |
| `candle-snapshot-15m-dirty.json` | **sintético** | — | Construido a mano a partir del real. Cada fila mala ejercita una causa de descarte distinta: campos faltantes, `high < low`, `t` desalineado, precio no numérico y volumen negativo. Las filas 1 y 7 son válidas |

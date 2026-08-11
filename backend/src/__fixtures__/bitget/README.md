# Fixtures de Bitget

Payloads usados por los tests del adaptador del exchange. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`, y es un criterio del phase gate G1).

Los ficheros **reales** están capturados tal cual los devolvió la API, sin editar ni un carácter: son
la evidencia de la forma real del contrato. La procedencia de cada uno vive aquí y no dentro del JSON
precisamente para no alterarlos.

Todos se capturaron el **2026-08-10** contra `https://api.bitget.com`, endpoint
`GET /api/v2/mix/market/history-candles`, con `symbol=BTCUSDT` y `productType=USDT-FUTURES`.

| Fichero | Origen | Petición | Qué demuestra |
|---|---|---|---|
| `history-candles-15m-ok.json` | **real** | `granularity=15m&limit=5&startTime=1767225600000&endTime=1767230100000` | Respuesta correcta: 5 velas de 15m del 2026-01-01, orden ascendente, 7 campos string por vela |
| `history-candles-empty.json` | **real** | `granularity=15m&limit=5&startTime=1420070400000&endTime=1420074900000` | Rango anterior a la existencia del par: `data: []` con `code: "00000"`. No es un error; es la señal de fin de histórico que consumirá F1-T8 |
| `error-limit-out-of-range.json` | **real** | `granularity=15m&limit=1001` | El máximo real de `limit` es 200, no 1000. Error de negocio con **HTTP 200** y `code: "40053"` |
| `error-bad-granularity.json` | **real** | `granularity=1h&limit=1` | `granularity` es sensible a mayúsculas: `1h` se rechaza con `code: "400171"` y la lista de valores admitidos. Hay que mandar `1H` |
| `history-candles-15m-dirty.json` | **sintético** | — | Construido a mano a partir del fichero real anterior. Cada fila mala ejercita una causa de descarte distinta: campos faltantes, `high < low`, `ts` desalineado, precio no numérico y volumen negativo. Las filas 1 y 7 son válidas y deben sobrevivir |

## WebSocket

Capturados el **2026-08-11** contra `wss://ws.bitget.com/v2/ws/public`, suscribiendo
`{instType: "USDT-FUTURES", channel, instId: "BTCUSDT"}`. Endpoint público, sin API key.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `ws-event-subscribe.json` | **real** | Confirmación de suscripción: `{event, arg}`, sin `code` ni `msg` |
| `ws-event-error.json` | **real** | `channel: "candle1h"` en minúscula se rechaza con `code: 30016` (**número**, no string) y `msg: "Param error"`. El canal correcto es `candle1H` |
| `ws-snapshot-1m.json` | **real, recortado** | Envoltorio `{action, arg, data, ts}` con `action: "snapshot"`. **Las velas traen 8 campos, no los 7 del REST.** El snapshot real llega con **500 velas**; aquí se han conservado solo las 3 últimas para que el fichero sea legible. Nada más se ha tocado |
| `ws-update-forming.json` | **real** | `action: "update"` con una sola vela: la vela en formación, mismo `ts` que la última del snapshot y volumen mayor |
| `ws-update-rollover.json` | **real** | El update en el que el `ts` salta 60.000 ms. Es la señal de que la vela anterior está cerrada; capturado esperando al cambio de minuto |

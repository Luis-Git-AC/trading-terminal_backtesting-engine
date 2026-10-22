# Fixtures de Binance

Payloads usados por los tests del adaptador de Binance. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

Los ficheros **reales** están capturados tal cual los devolvió la API, sin editar ni un carácter.
La procedencia vive aquí y no dentro del JSON, para no alterarlos.

Capturados el **2026-10-22** contra `https://fapi.binance.com`, endpoint `GET /fapi/v1/klines`,
con `symbol=BTCUSDT`. Endpoint público, sin API key.

| Fichero | Origen | Petición | Qué demuestra |
|---|---|---|---|
| `klines-15m-ok.json` | **real** | `interval=15m&limit=5&startTime=1767225600000&endTime=1767230100000` | Respuesta correcta: array plano de 5 filas de 12 campos, con `openTime` y `closeTime` **numéricos** y los precios en string. El campo 7 es el `quote_volume` |
| `klines-empty.json` | **real** | `interval=15m&limit=5&startTime=1420070400000&endTime=1420074900000` | Rango anterior a la existencia del par: `[]` con HTTP 200. No es un error; es la señal de fin de histórico |
| `error-bad-interval.json` | **real** | `interval=3x&limit=5` | Error de negocio con **HTTP 400** y `code` **numérico** negativo |
| `error-limit-out-of-range.json` | **real** | `interval=15m&limit=2000` | El máximo real de `limit` es 1500: `code: -1130` |
| `klines-15m-dirty.json` | **sintético** | — | Construido a mano a partir del real. Cada fila mala ejercita una causa de descarte distinta: campos faltantes, `high < low`, `ts` desalineado, precio no numérico y volumen negativo. Las filas 1 y 7 son válidas y deben sobrevivir |

## WebSocket

El stream combinado `wss://fstream.binance.com/stream` aceptó la suscripción desde esta red
(`{"result":null,"id":1}` es **real**), pero no llegó ni una kline en 30 s de espera, así que los
frames de vela están **construidos a mano** a partir de la forma documentada del payload
`<symbol>@kline_<interval>`. Si algún día se capturan de verdad, se sustituyen y se marca aquí.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `ws-ack.json` | **real** | Confirmación de `SUBSCRIBE`: `{result: null, id}`. No dice qué stream confirma, de ahí el mapa id -> serie |
| `ws-kline-forming.json` | **sintético** | Envoltorio `{stream, data}` con `k.x: false`: vela en formación, se publica pero no se persiste |
| `ws-kline-closed.json` | **sintético** | La misma vela con `k.x: true`: cerrada, es la única que entra en la BD |
| `ws-error.json` | **sintético** | `{error: {code, msg}}` con `code` **numérico**, la forma documentada del rechazo |

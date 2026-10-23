# Fixtures de DefiLlama

Payloads usados por los tests de la fuente DefiLlama. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**Los dos son reales**, capturados el **2026-10-23** (la API es pública y sin clave), recortados a
los últimos puntos del histórico y con el resto del fichero fuera: el de TVL pesa 123 kB y el de
stablecoins 1,3 MB enteros, y lo que los tests necesitan son las últimas filas.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `historical-chain-tvl.json` | **real (2026-10-23)**, `https://api.llama.fi/v2/historicalChainTvl`, últimos 4 puntos de 1.424 | TVL diario agregado. El `date` llega como **número** en segundos |
| `stablecoins-all.json` | **real (2026-10-23)**, `https://stablecoins.llama.fi/stablecoincharts/all`, últimos 3 puntos | Circulante de stablecoins. El `date` aquí llega como **string**, no como número, y por eso el esquema acepta los dos. Se usa `totalCirculatingUSD.peggedUSD` (valorado en dólares) y **no** `totalCirculating`, que está en unidades de cada moneda; el último punto trae además `totalMintedUSD` y `totalBridgedToUSD`, campos que la fuente ignora |

## `published_at`

Ninguno de los dos endpoints dice cuándo se calculó el punto: son la foto de ese día, así que
`published_at` es el propio instante del punto, que es lo único estable (entra en la comparación de
revisiones y no puede cambiar entre pasadas). El corte point-in-time de un backtest lo da
`fetched_at`, que sí es real.

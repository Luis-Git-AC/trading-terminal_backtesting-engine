# Fixtures de CoinGecko

Payloads usados por los tests de la fuente CoinGecko. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `global.json` | **real (2026-10-23)**, `https://api.coingecko.com/api/v3/global`, con las divisas recortadas | Market cap total y reparto de dominancia. **`updated_at` (segundos) es el único `published_at` real de las cinco fuentes**: CoinGecko dice cuándo calculó la foto, así que ese instante es a la vez el `ts` de la observación y su publicación. La respuesta real trae ~60 divisas en `total_market_cap` y `total_volume` y ~10 monedas en `market_cap_percentage`; aquí quedan `btc`, `eth` y `usd`, que son las que se leen. El resto de campos (`active_cryptocurrencies`, `markets`, `market_cap_change_percentage_24h_usd`) está tal cual para que se vea la forma completa |
| `error-429.json` | **sintético** | Cuerpo del 429 del tier gratuito, con `status.error_code` y `status.error_message`. No se ha provocado un 429 real contra la API (sería abusar de un servicio gratuito para un test), así que está construido a partir del mensaje que documenta CoinGecko. Lo que el test comprueba es que un 429 es **reintentable** y deja constancia: el job se reprograma con su backoff en vez de tumbar el proceso |

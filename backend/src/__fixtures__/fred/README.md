# Fixtures del FRED

Payloads usados por los tests de la fuente FRED. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**Los cuatro son sintéticos.** `fred/series/observations` y `fred/releases/dates` exigen `api_key`
obligatoria y el proyecto todavía no tiene ninguna (`FRED_API_KEY` está vacía en `.env`), así que no
se ha podido capturar ni uno real. Están construidos a partir de la forma documentada en
`https://fred.stlouisfed.org/docs/api/fred/series_observations.html` y
`.../releases_dates.html`, leída el **2026-10-22**: nombres de campo, orden y tipos son los de los
ejemplos de esa documentación, incluido que `value` es **string** y `release_id` **número**. Cuando
haya clave se capturan de verdad, se sustituyen y se marca aquí.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `observations-dfii10.json` | **sintético** | Serie diaria sin revisiones: una fila por fecha, todas con `realtime_end: "9999-12-31"`. La tercera trae `value: "."`, que es cómo el FRED publica un dato ausente, y es la que tiene que descartarse con motivo en vez de entrar como 0 |
| `observations-gdpc1-revisada.json` | **sintético** | **El caso que justifica la columna `revision`.** La fecha de observación `2026-04-01` aparece **dos veces** con `realtime_start` distinto: la publicación del 30-jul (`realtime_end` cerrado el 27-ago, porque dejó de ser la vigente) y la corrección del 28-ago. Ordenadas por `realtime_start` dan revisión 0 y 1 |
| `release-dates.json` | **sintético** | Calendario de publicaciones, que alimenta `market_events`. La tercera entrada **no trae `release_name`**: la documentación lo muestra siempre, pero el esquema no lo exige y cae al id, así que una respuesta sin él no rompe la recogida |
| `error-bad-series.json` | **sintético** | Cuerpo de error del FRED, que llega con HTTP 400: `error_code` **numérico** y `error_message`. Un 400 no se reintenta; un 429 o un 5xx sí |

## Ventana realtime

Las observaciones se piden con `realtime_start=1776-07-04&realtime_end=9999-12-31` y
`output_type=1`, que es el de por defecto. Así el FRED devuelve **una fila por vintage** de cada
fecha, cada una con su propio `realtime_start`, que es de donde sale `published_at` y de donde sale
el número de revisión. Con la ventana por defecto (hoy, hoy) solo llegaría la última y la revisión
sería invisible, que es justo lo que `macro_series` existe para no perder.

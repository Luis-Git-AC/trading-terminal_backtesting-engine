# Fixtures del FRED

Payloads usados por los tests de la fuente FRED. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**Cuatro sintéticos y uno real.** Los cuatro primeros se escribieron el **2026-10-22**, cuando el
proyecto no tenía `FRED_API_KEY`, a partir de la forma documentada en
`https://fred.stlouisfed.org/docs/api/fred/series_observations.html` y `.../releases_dates.html`:
nombres de campo, orden y tipos son los de los ejemplos de esa documentación, incluido que `value`
es **string** y `release_id` **número**. El de vintages se capturó con la clave real el
**2026-10-23**, al arreglar F9-T9.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `observations-dfii10.json` | **sintético** | Serie diaria sin revisiones: una fila por fecha, todas con `realtime_end: "9999-12-31"`. La tercera trae `value: "."`, que es cómo el FRED publica un dato ausente, y es la que tiene que descartarse con motivo en vez de entrar como 0 |
| `observations-gdpc1-revisada.json` | **sintético** | **El caso que justifica la columna `revision`.** La fecha de observación `2026-04-01` aparece **dos veces** con `realtime_start` distinto: la publicación del 30-jul (`realtime_end` cerrado el 27-ago, porque dejó de ser la vigente) y la corrección del 28-ago. Ordenadas por `realtime_start` dan revisión 0 y 1 |
| `release-dates.json` | **sintético** | Calendario de publicaciones, que alimenta `market_events`. La tercera entrada **no trae `release_name`**: la documentación lo muestra siempre, pero el esquema no lo exige y cae al id, así que una respuesta sin él no rompe la recogida |
| `vintage-dates-dfii10.json` | **real**, capturado el 2026-10-23 (`series/vintagedates`, `DFII10`, `realtime_start=2026-10-20`) | La forma de la respuesta que marca el troceado: `vintage_dates` es un array de strings `YYYY-MM-DD`. Tres fechas, que es lo que cabe en un solo tramo |
| `error-bad-series.json` | **sintético** | Cuerpo de error del FRED, que llega con HTTP 400: `error_code` **numérico** y `error_message`. Un 400 no se reintenta; un 429 o un 5xx sí |

## Ventana realtime

Las observaciones se piden con `output_type=1` (el de por defecto) y una ventana realtime amplia:
así el FRED devuelve **una fila por vintage** de cada fecha, cada una con su propio
`realtime_start`, que es de donde sale `published_at`. Con la ventana por defecto (hoy, hoy) solo
llegaría la última y la revisión sería invisible, que es justo lo que `macro_series` existe para no
perder.

La ventana **no puede ser toda la historia** (F9-T9). El FRED admite como máximo **2000 fechas de
vintage** por petición con `file_type=json` y responde 400 si se pasa; `DFII10` acumulaba 2918
desde 2015 el 2026-10-23, porque estrena una cada día hábil. Así que la fuente pregunta primero por
`series/vintagedates` y trocea la ventana en bloques de 1000 vintages, dejando el último abierto en
`9999-12-31` para que entren los de hoy.

El número de revisión **no** sale de la posición en la respuesta, sino de las fechas de vintage
frente a lo ya guardado: un vintage que no es posterior al último `published_at` de la tabla ya se
conoce y se ignora, y los posteriores continúan la numeración de su fecha. La regla por valor de
`sources/revisions.ts` es la de las fuentes que **no** sirven vintages (CFTC, DefiLlama,
CoinGecko); aquí comparar por valor volvería a meter como corrección cada vintage reservido.

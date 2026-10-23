# Fixtures de la EIA

Payloads usados por los tests de la fuente EIA. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**`error-missing-key.json` es real**, capturado el **2026-10-23** con
`curl "https://api.eia.gov/v2/petroleum/stoc/wstk/data/?frequency=weekly&data[0]=value&length=1"`,
que responde **HTTP 403** porque la ruta exige `api_key`. **Los dos de datos son sintéticos**: sin
clave (`EIA_API_KEY` está vacía en `.env`) la API v2 no devuelve ni una fila, así que no se ha
podido capturar ninguno. Están construidos a partir de la forma documentada en
`https://www.eia.gov/opendata/documentation.php` y de la respuesta de la ruta
`petroleum/stoc/wstk`, leída el **2026-10-23**: nombres de campo, anidamiento bajo `response.data`
y tipos son los de esa documentación, incluido que `value` es **número** (al contrario que el FRED,
donde es string) y que `total` llega como string. Cuando haya clave se capturan de verdad, se
sustituyen y se marca aquí.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `stocks-weekly.json` | **sintético** | Tres semanas de inventarios (crudo, gasolina y destilados) con el `period` en el **viernes de cierre** y varias series en la misma respuesta, que es como las devuelve una petición con la faceta `series` repetida. La fila de destilados del `2026-10-16` trae `value: null`, que es cómo la EIA publica un dato ausente, y es la que tiene que descartarse con motivo en vez de entrar como 0 |
| `stocks-weekly-revisada.json` | **sintético** | La misma respuesta con el crudo del `2026-10-09` corregido (419.800 → 418.425). **El caso que justifica deducir la revisión al persistir**: la API v2 solo sirve el valor vigente, sin vintages, así que el número de revisión no viene en la respuesta y sale de comparar con lo ya guardado |
| `error-missing-key.json` | **real (2026-10-23)** | Cuerpo de error de la API v2: `error.code` y `error.message` anidados, nada que ver con el `error_code`/`error_message` planos del FRED. Un 403 por clave no se reintenta; un 429 o un 5xx sí |

## Calendario de publicación

El Weekly Petroleum Status Report cubre la semana que cierra el **viernes** y se publica el
**miércoles siguiente a las 10:30 de Nueva York**. `scheduled_at` es ese instante y la respuesta de
datos **no trae ninguna marca de publicación real**, así que `published_at` usa el mismo instante
(anotado como desviación en `PROGRESS.md`). El corte point-in-time de un backtest lo da `fetched_at`,
que sí es real.

# Fixtures de la EIA

Payloads usados por los tests de la fuente EIA. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**`error-missing-key.json` y `stocks-weekly.json` son reales**, capturados el **2026-10-23**: el
primero con `curl` sin clave (**HTTP 403**, porque la ruta exige `api_key`) y el segundo con la
clave real y **los mismos parámetros que manda el cliente**, con la `api_key` borrada del eco de
`request.params` antes de guardarlo. `stocks-weekly-revisada.json` se deriva del real cambiando un
único valor: la EIA no sirve vintages, así que una corrección no se puede capturar, solo modelar.

Los fixtures de datos anteriores a esta fecha **eran sintéticos y daban `value` como número**, que
es lo que dejó pasar el fallo de F9-T10: la API v2 lo sirve **entre comillas** (`"424134"`), y el
esquema con `z.number()` reventaba la recogida entera con un `ZodError` por fila. Ahora el esquema
acepta string o número y la conversión la hace `numericValue`.

| Fichero | Origen | Qué demuestra |
|---|---|---|
| `stocks-weekly.json` | **real (2026-10-23)**, respuesta completa de `petroleum/stoc/wstk` con `start=2026-10-02` y las tres series de `EIA_SERIES` | Nueve filas: tres semanas por tres series, con el `period` en el **viernes de cierre** y varias series en la misma respuesta, que es como las devuelve la faceta `series` repetida. **`value` llega entre comillas** y `total` también. Ninguna fila trae `null`: el caso del dato ausente y el del valor no numérico se prueban con un raw armado a mano en el test, marcado como tal |
| `stocks-weekly-revisada.json` | **derivado del real**: mismo payload con el crudo del `2026-10-09` corregido (415.577 → 413.727) | **El caso que justifica deducir la revisión al persistir**: la API v2 solo sirve el valor vigente, sin vintages, así que el número de revisión no viene en la respuesta y sale de comparar con lo ya guardado |
| `error-missing-key.json` | **real (2026-10-23)** | Cuerpo de error de la API v2: `error.code` y `error.message` anidados, nada que ver con el `error_code`/`error_message` planos del FRED. Un 403 por clave no se reintenta; un 429 o un 5xx sí |

## Calendario de publicación

El Weekly Petroleum Status Report cubre la semana que cierra el **viernes** y se publica el
**miércoles siguiente a las 10:30 de Nueva York**. `scheduled_at` es ese instante y la respuesta de
datos **no trae ninguna marca de publicación real**, así que `published_at` usa el mismo instante
(anotado como desviación en `PROGRESS.md`). El corte point-in-time de un backtest lo da `fetched_at`,
que sí es real.

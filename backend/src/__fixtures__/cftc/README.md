# Fixtures de la CFTC

Payloads usados por los tests de la fuente CFTC. Ningún test llama a la red real
(`docs/05-TESTING.md §Datos y fixtures`).

**`deafut-recortado.txt` es real**, capturado el **2026-10-23** de
`https://www.cftc.gov/dea/newcot/deafut.txt` (el informe legacy *futures only*, público y sin clave:
HTTP 200, `text/plain`, 423.115 bytes, `last-modified` del 2026-10-19). Son **cinco filas del
fichero real, byte a byte**, del informe del **martes 2026-10-13**:

| Fila | Mercado | Código | Por qué está |
|---|---|---|---|
| 1 | `WHEAT-SRW - CHICAGO BOARD OF TRADE` | `001602` | Mercado que **no** se sigue: tiene que quedarse fuera mientras se lee |
| 2 | `WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE` | `067651` | WTI. **El nombre cambió** (era `CRUDE OIL, LIGHT SWEET`), que es por lo que el filtro va por código y no por nombre |
| 3 | `SILVER - COMMODITY EXCHANGE INC.` | `084691` | Plata |
| 4 | `GOLD - COMMODITY EXCHANGE INC.` | `088691` | Oro |
| 5 | `CRUDE OIL, LIGHT SWEET-WTI - ICE FUTURES EUROPE` | `06741Q` | **Nombre con una coma dentro de las comillas**, que rompe un `split(',')` ingenuo y descolocaría todos los campos. Tampoco se sigue |

El fichero **no trae cabecera**. Las posiciones usadas se verificaron contra la propia aritmética
del formato legacy: no comerciales largas + spread + comerciales largas = total reportable largas
(oro: 245.300 + 45.895 + 54.419 = 345.614). El neto no comercial que persiste la fuente es
largas − cortas: **oro +207.879, plata +22.631, WTI +100.343**.

## El desfase martes/viernes

El informe refleja las posiciones del **martes** y se publica el **viernes a las 15:30 de Nueva
York**. `scheduled_at` es el martes y `published_at` el viernes, tres días después: usar la fecha
del informe como si se conociera el martes es look-ahead bias de tres días, el error clásico con
esta serie. Hay un itest que lo demuestra con una consulta `asOf` del miércoles.

El fixture grande del test de streaming **no está aquí**: lo genera el propio test al vuelo (~48 MB
de filas sintéticas), porque un fichero de ese tamaño no tiene sitio en un repositorio.

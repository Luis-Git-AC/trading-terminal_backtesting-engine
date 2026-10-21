---
description: Verifica el phase gate de la fase indicada y lo cierra si todo pasa
---

Comprueba el phase gate de la fase `$ARGUMENTS` (si viene vacío, la fase activa según `PROGRESS.md`).

1. Confirma que **todos** los tickets de la fase están en estado `hecho`. Si alguno no lo está,
   lístalos y para.
2. Abre `docs/phases/phase-N.md §Phase gate` y ejecuta cada punto de la checklist de verdad:
   ejecuta los comandos, inspecciona las salidas, comprueba los datos en la BD si hace falta.
   No des por bueno nada por inferencia.
3. Para cada punto, informa: ✅ con la evidencia (comando + resultado resumido) o ❌ con lo que falla.
4. Si todo pasa: marca el gate como cerrado en `PROGRESS.md` (✅ y fecha), actualiza la fase activa a
   la siguiente y el siguiente ticket. Commit `chore(gN): cierre del phase gate N`.
5. Si algo falla: **no cierres el gate**. Crea un ticket extra `FN-Tx` al final de
   `docs/phases/phase-N.md` describiendo el arreglo necesario (objetivo, archivos, aceptación,
   verificación), añádelo a `PROGRESS.md` como `pendiente`, y dilo claramente.

Sé estricto. Un gate cerrado en falso hace que el problema reaparezca tres fases más tarde,
mezclado con otros diez cambios.

---
description: Implementa el siguiente ticket pendiente del roadmap, de principio a fin
---

Ejecuta el ciclo de trabajo autónomo definido en `CLAUDE.md §3` para **un solo ticket**.

Argumentos opcionales: `$ARGUMENTS` puede ser un ID de ticket (`F2-T4`). Si viene vacío, coge el
primero con estado `pendiente` de la fase activa.

Pasos:

1. Lee `PROGRESS.md` y determina la fase activa y el ticket a ejecutar.
2. Comprueba que el phase gate de la fase anterior está cerrado. Si no lo está, **para** y dilo.
3. Lee el ticket completo en `docs/phases/phase-N.md` y los documentos que referencia
   (`docs/01`–`docs/06` según corresponda). No improvises lo que ya está decidido.
4. Marca el ticket como `en curso` en `PROGRESS.md`.
5. Implementa el ticket: código **y** tests. Nada de trabajo de tickets futuros.
6. Ejecuta el bloque de **Verificación** del ticket, más `npm run typecheck && npm run lint && npm run test`.
   Si algo falla, arréglalo antes de continuar. No marques como hecho con tests rojos o saltados.
7. Repasa la lista de **Aceptación** del ticket punto por punto y confirma cada uno con evidencia real
   (salida de comando o test concreto), no por impresión.
8. Actualiza `PROGRESS.md`: estado `hecho`, fecha, y anota en las tablas del final cualquier decisión
   nueva, desviación respecto a la documentación o bloqueo encontrado.
9. Commit siguiendo `CLAUDE.md §7`.
10. Termina informando: qué se hizo, qué verificaste, y cuál es el siguiente ticket.

Si te bloqueas por algo que solo el usuario puede resolver (credencial, cuenta, decisión de producto),
anótalo en `PROGRESS.md §Bloqueos abiertos`, deja el ticket en `bloqueado` y pregunta.

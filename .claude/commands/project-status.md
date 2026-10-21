---
description: Resume el estado real del proyecto contrastando PROGRESS.md con el código
---

Da un parte de situación honesto. No te limites a leer `PROGRESS.md`: verifícalo.

1. Lee `PROGRESS.md`: fase activa, tickets hechos/pendientes, bloqueos, gates cerrados.
2. Contrasta con la realidad del repositorio:
   - ¿Existen los archivos que los tickets marcados como `hecho` deberían haber creado?
   - `npm run typecheck && npm run lint && npm run test` — ¿está en verde ahora mismo?
   - ¿Hay tests con `.skip`/`.only` o suites vacías? (`grep` por `it.skip`, `describe.only`, `test.todo`)
   - ¿Hay migraciones sin aplicar? ¿`.env.example` sincronizado con el esquema de env?
   - Estado de git: rama, cambios sin commitear, commits sin push.
3. Informa en este orden:
   - **Dónde estamos**: fase, % de tickets cerrados, próximo ticket.
   - **Discrepancias** entre `PROGRESS.md` y el código (lo más importante del comando).
   - **Salud**: typecheck/lint/tests, deuda visible.
   - **Definition of done**: qué condiciones del PRD están cumplidas y con qué evidencia.
   - **Bloqueos** que requieren al usuario.
4. Si encuentras discrepancias, corrige `PROGRESS.md` para que refleje la realidad y dilo.

Sé directo con lo que no está hecho. Un estado optimista es peor que no tener estado.

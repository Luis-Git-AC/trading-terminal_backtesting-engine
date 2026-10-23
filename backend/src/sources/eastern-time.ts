/**
 * Horas de Nueva York, que es con lo que anuncian sus publicaciones la EIA (10:30) y la CFTC
 * (15:30). El desplazamiento cambia dos veces al ano, asi que una constante UTC seria correcta
 * media parte del ano: aqui se calcula con la base de zonas horarias de Node.
 */
export const EASTERN_TIMEZONE = 'America/New_York';

const zonedFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Lo que Nueva York adelanta o atrasa respecto a UTC en ese instante: EST o EDT segun la fecha. */
function offsetMs(utcMs: number): number {
  const parts = new Map(
    zonedFormat.formatToParts(utcMs).map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.get('year') ?? 0,
    (parts.get('month') ?? 1) - 1,
    parts.get('day') ?? 1,
    parts.get('hour') ?? 0,
    parts.get('minute') ?? 0,
  );
  return wall - utcMs;
}

/**
 * Instante UTC de las `hour:minute` de Nueva York del dia natural de `utcDayMs`. Dos pasadas: la
 * primera corrige con el desplazamiento del dia y la segunda con el del instante ya corregido, que
 * es lo que resuelve los domingos de cambio de hora.
 */
export function atEasternTime(utcDayMs: number, hour: number, minute: number): number {
  const day = new Date(utcDayMs);
  const wall = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  const first = wall - offsetMs(wall);
  return wall - offsetMs(first);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** El primer dia posterior a `fromMs` que cae en ese dia de la semana (0 domingo, 6 sabado). */
export function nextWeekday(fromMs: number, weekday: number): number {
  let dayMs = fromMs + DAY_MS;
  while (new Date(dayMs).getUTCDay() !== weekday) dayMs += DAY_MS;
  return dayMs;
}

export const CHART_TOKENS = [
  'bg',
  'surfaceSunken',
  'border',
  'text',
  'textTertiary',
  'up',
  'down',
  'accent',
] as const;

export type ChartTokenName = (typeof CHART_TOKENS)[number];

export type ChartTheme = Record<ChartTokenName, string>;

const CSS_VARIABLE: Record<ChartTokenName, string> = {
  bg: '--color-bg',
  surfaceSunken: '--color-surface-sunken',
  border: '--color-border',
  text: '--color-text',
  textTertiary: '--color-text-tertiary',
  up: '--color-up',
  down: '--color-down',
  accent: '--color-accent',
};

export const FALLBACK_THEME: ChartTheme = {
  bg: 'transparent',
  surfaceSunken: 'transparent',
  border: 'gray',
  text: 'silver',
  textTertiary: 'gray',
  up: 'green',
  down: 'crimson',
  accent: 'royalblue',
};

export function readChartTheme(element: Element): ChartTheme {
  const styles = globalThis.getComputedStyle(element);

  const read = (token: ChartTokenName): string => {
    const value = styles.getPropertyValue(CSS_VARIABLE[token]).trim();
    return value === '' ? FALLBACK_THEME[token] : value;
  };

  return {
    bg: read('bg'),
    surfaceSunken: read('surfaceSunken'),
    border: read('border'),
    text: read('text'),
    textTertiary: read('textTertiary'),
    up: read('up'),
    down: read('down'),
    accent: read('accent'),
  };
}

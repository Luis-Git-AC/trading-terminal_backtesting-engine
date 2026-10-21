export const CHART_TOKENS = [
  'bg',
  'surfaceSunken',
  'border',
  'grid',
  'text',
  'textTertiary',
  'up',
  'down',
  'volumeUp',
  'volumeDown',
  'spanUp',
  'spanDown',
  'accent',
  'watermark',
  'fontSans',
  'fontMono',
] as const;

export type ChartTokenName = (typeof CHART_TOKENS)[number];

export type ChartTheme = Record<ChartTokenName, string>;

const CSS_VARIABLE: Record<ChartTokenName, string> = {
  bg: '--color-bg',
  surfaceSunken: '--color-surface-sunken',
  border: '--color-border',
  grid: '--color-chart-grid',
  text: '--color-text',
  textTertiary: '--color-text-tertiary',
  up: '--color-up',
  down: '--color-down',
  volumeUp: '--color-volume-up',
  volumeDown: '--color-volume-down',
  spanUp: '--color-span-up',
  spanDown: '--color-span-down',
  accent: '--color-accent',
  watermark: '--color-chart-watermark',
  fontSans: '--font-sans',
  fontMono: '--font-mono',
};

export const FALLBACK_THEME: ChartTheme = {
  bg: 'transparent',
  surfaceSunken: 'transparent',
  border: 'gray',
  grid: 'gainsboro',
  text: 'silver',
  textTertiary: 'gray',
  up: 'green',
  down: 'crimson',
  volumeUp: 'green',
  volumeDown: 'crimson',
  spanUp: 'transparent',
  spanDown: 'transparent',
  accent: 'royalblue',
  watermark: 'transparent',
  fontSans: 'sans-serif',
  fontMono: 'monospace',
};

export function readChartTheme(element: Element): ChartTheme {
  const styles = globalThis.getComputedStyle(element);

  const read = (token: ChartTokenName): string => {
    const value = styles.getPropertyValue(CSS_VARIABLE[token]).replace(/\s+/g, ' ').trim();
    return value === '' ? FALLBACK_THEME[token] : value;
  };

  return {
    bg: read('bg'),
    surfaceSunken: read('surfaceSunken'),
    border: read('border'),
    grid: read('grid'),
    text: read('text'),
    textTertiary: read('textTertiary'),
    up: read('up'),
    down: read('down'),
    volumeUp: read('volumeUp'),
    volumeDown: read('volumeDown'),
    spanUp: read('spanUp'),
    spanDown: read('spanDown'),
    accent: read('accent'),
    watermark: read('watermark'),
    fontSans: read('fontSans'),
    fontMono: read('fontMono'),
  };
}

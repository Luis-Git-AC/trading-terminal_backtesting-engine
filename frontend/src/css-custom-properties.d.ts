import 'react';

declare module 'react' {
  interface CSSProperties {
    '--segment-count'?: number;
    '--segment-index'?: number;
    '--series-color'?: string;
    '--stagger-index'?: number;
  }
}

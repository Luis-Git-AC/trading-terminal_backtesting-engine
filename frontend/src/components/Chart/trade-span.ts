import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';

export interface TradeSpan {
  readonly from: UTCTimestamp;
  readonly to: UTCTimestamp;
  readonly fill: string;
  readonly edge: string;
}

export interface SpanPixels {
  readonly left: number;
  readonly width: number;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export function spanPixels(fromX: number | null, toX: number | null): SpanPixels | null {
  if (fromX === null || toX === null) {
    return null;
  }
  return { left: Math.min(fromX, toX), width: Math.max(Math.abs(toX - fromX), 1) };
}

class TradeSpanRenderer implements IPrimitivePaneRenderer {
  readonly pixels: SpanPixels;
  readonly span: TradeSpan;

  constructor(pixels: SpanPixels, span: TradeSpan) {
    this.pixels = pixels;
    this.span = span;
  }

  draw(): void {
    return;
  }

  drawBackground(target: DrawTarget): void {
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, bitmapSize }) => {
      const left = Math.round(this.pixels.left * horizontalPixelRatio);
      const width = Math.max(1, Math.round(this.pixels.width * horizontalPixelRatio));
      const edge = Math.max(1, Math.round(horizontalPixelRatio));

      context.fillStyle = this.span.fill;
      context.fillRect(left, 0, width, bitmapSize.height);

      context.fillStyle = this.span.edge;
      context.fillRect(left, 0, edge, bitmapSize.height);
      context.fillRect(left + width - edge, 0, edge, bitmapSize.height);
    });
  }
}

export class TradeSpanPrimitive implements ISeriesPrimitive<Time> {
  span: TradeSpan | null = null;

  private attachedTo: SeriesAttachedParameter<Time> | null = null;

  private pixels: SpanPixels | null = null;

  private readonly view: IPrimitivePaneView = {
    zOrder: (): PrimitivePaneViewZOrder => 'bottom',
    renderer: () =>
      this.pixels === null || this.span === null
        ? null
        : new TradeSpanRenderer(this.pixels, this.span),
  };

  attached(param: SeriesAttachedParameter<Time>): void {
    this.attachedTo = param;
    this.updateAllViews();
  }

  detached(): void {
    this.attachedTo = null;
    this.pixels = null;
  }

  setSpan(span: TradeSpan | null): void {
    this.span = span;
    this.updateAllViews();
    this.attachedTo?.requestUpdate();
  }

  updateAllViews(): void {
    const scale = this.attachedTo?.chart.timeScale();

    this.pixels =
      this.span === null || scale === undefined
        ? null
        : spanPixels(scale.timeToCoordinate(this.span.from), scale.timeToCoordinate(this.span.to));
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }
}

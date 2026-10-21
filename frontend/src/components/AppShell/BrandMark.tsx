import styles from './BrandMark.module.css';

const OUTER_NODES = [
  [16, 4],
  [26.4, 10],
  [26.4, 22],
  [16, 28],
  [5.6, 22],
  [5.6, 10],
] as const;

const SPOKES = [0, 2, 4] as const;

export function BrandMark() {
  const ring = OUTER_NODES.map(([x, y]) => `${String(x)},${String(y)}`).join(' ');

  return (
    <svg
      className={styles.logo}
      width="28"
      height="28"
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark"
    >
      <polygon className={styles.edge} points={ring} />
      {SPOKES.map((index) => {
        const [x, y] = OUTER_NODES[index];
        return <line key={index} className={styles.spoke} x1="16" y1="16" x2={x} y2={y} />;
      })}
      {OUTER_NODES.map(([x, y]) => (
        <circle key={`${String(x)}-${String(y)}`} className={styles.node} cx={x} cy={y} r="2.2" />
      ))}
      <circle className={styles.core} cx="16" cy="16" r="3.2" />
    </svg>
  );
}

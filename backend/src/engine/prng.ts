const INCREMENT = 0x6d2b79f5;

const UINT32 = 4_294_967_296;

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + INCREMENT) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

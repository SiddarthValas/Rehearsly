/* Agreement statistics between two raters on a 0-10 scale. */

export type Agreement = {
  n: number;
  exact: number; // % of answers given the same score
  within1: number; // % within one point
  mae: number; // mean absolute difference, in points
  pearson: number | null;
  kappa: number | null; // quadratic weighted Cohen's kappa, the standard for graded essays
};

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : null;
}

/** Quadratic weighted kappa over the integer categories 0..10. 1 = perfect, 0 = chance level. */
export function qwk(a: number[], b: number[], categories = 11): number | null {
  const n = a.length;
  if (n < 3) return null;
  const observed = Array.from({ length: categories }, () => new Array<number>(categories).fill(0));
  const histA = new Array<number>(categories).fill(0);
  const histB = new Array<number>(categories).fill(0);
  for (let i = 0; i < n; i++) {
    const x = Math.max(0, Math.min(categories - 1, Math.round(a[i])));
    const y = Math.max(0, Math.min(categories - 1, Math.round(b[i])));
    observed[x][y] += 1;
    histA[x] += 1;
    histB[y] += 1;
  }
  let num = 0, den = 0;
  for (let i = 0; i < categories; i++) {
    for (let j = 0; j < categories; j++) {
      const weight = (i - j) ** 2 / (categories - 1) ** 2;
      num += weight * observed[i][j];
      den += weight * (histA[i] * histB[j]) / n;
    }
  }
  return den ? 1 - num / den : null;
}

export function agreement(a: number[], b: number[]): Agreement {
  const n = Math.min(a.length, b.length);
  const diffs = Array.from({ length: n }, (_, i) => Math.abs(a[i] - b[i]));
  const r = pearson(a.slice(0, n), b.slice(0, n));
  const k = qwk(a.slice(0, n), b.slice(0, n));
  return {
    n,
    exact: n ? Math.round((100 * diffs.filter((d) => d < 0.5).length) / n) : 0,
    within1: n ? Math.round((100 * diffs.filter((d) => d <= 1).length) / n) : 0,
    mae: n ? round(diffs.reduce((s, d) => s + d, 0) / n, 1) : 0,
    pearson: r == null ? null : round(r),
    kappa: k == null ? null : round(k),
  };
}

/** Average several agreements (e.g. every pair of human raters), weighting by answers compared. */
export function mean(list: Agreement[]): Agreement | null {
  const usable = list.filter((a) => a.n > 0);
  if (!usable.length) return null;
  const total = usable.reduce((s, a) => s + a.n, 0);
  const avg = (pick: (a: Agreement) => number | null, places: number) => {
    const values = usable.filter((a) => pick(a) != null);
    if (!values.length) return null;
    const weight = values.reduce((s, a) => s + a.n, 0);
    return round(values.reduce((s, a) => s + (pick(a) as number) * a.n, 0) / weight, places);
  };
  return {
    n: Math.round(total / usable.length),
    exact: Math.round(avg((a) => a.exact, 0) ?? 0),
    within1: Math.round(avg((a) => a.within1, 0) ?? 0),
    mae: avg((a) => a.mae, 1) ?? 0,
    pearson: avg((a) => a.pearson, 2),
    kappa: avg((a) => a.kappa, 2),
  };
}

/** How people usually read a kappa value (Landis & Koch). */
export function kappaLabel(k: number | null): string {
  if (k == null) return "not enough data";
  if (k >= 0.8) return "almost perfect";
  if (k >= 0.6) return "substantial";
  if (k >= 0.4) return "moderate";
  if (k >= 0.2) return "fair";
  return "slight";
}

function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j++;
    const rank = (i + j) / 2 + 1; // ties share their average rank
    for (let k = i; k <= j; k++) out[order[k].index] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation: does one list put things in the same order as the other? */
export function spearman(a: number[], b: number[]): number | null {
  const r = pearson(ranks(a), ranks(b));
  return r == null ? null : round(r);
}

import { useState } from "react";

/* Hand-built SVG charts. Single-series throughout, so no legend boxes: titles name the series.
   Every chart has a hover layer and an accessible text alternative. */

export function Radar({ items, size = 300 }: { items: { label: string; score: number }[]; size?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = items.length;
  const pad = 62;
  const c = size / 2;
  const r = c - pad;
  const point = (i: number, value: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [c + Math.cos(angle) * r * value, c + Math.sin(angle) * r * value] as const;
  };
  const shape = items.map((item, i) => point(i, Math.max(0.02, item.score / 10)).join(",")).join(" ");
  return (
    <figure className="radar">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={items.map((i) => `${i.label} ${i.score} of 10`).join(", ")}>
        {[0.25, 0.5, 0.75, 1].map((ring) => (
          <polygon key={ring} className="radar-ring" points={items.map((_, i) => point(i, ring).join(",")).join(" ")} />
        ))}
        {items.map((_, i) => {
          const [x, y] = point(i, 1);
          return <line key={i} className="radar-spoke" x1={c} y1={c} x2={x} y2={y} />;
        })}
        <polygon className="radar-area" points={shape} pathLength={1} />
        {items.map((item, i) => {
          const [x, y] = point(i, Math.max(0.02, item.score / 10));
          const [lx, ly] = point(i, 1.2);
          const anchor = Math.abs(lx - c) < 8 ? "middle" : lx > c ? "start" : "end";
          return (
            <g key={item.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0}>
              <circle cx={x} cy={y} r={14} fill="transparent" />
              <circle className="radar-dot" cx={x} cy={y} r={hover === i ? 6 : 4.5} />
              <text className={`radar-label ${hover === i ? "on" : ""}`} x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle">
                {item.label}
              </text>
              <text className="radar-value" x={lx} y={ly + 15} textAnchor={anchor} dominantBaseline="middle">
                {item.score}/10
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function Trend({ points, height = 180 }: { points: { score: number; label: string; sub?: string }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const padX = 34;
  const padY = 22;
  if (!points.length) return null;
  const x = (i: number) => (points.length === 1 ? width / 2 : padX + (i * (width - padX * 2)) / (points.length - 1));
  const y = (v: number) => padY + (1 - v / 100) * (height - padY * 2);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.score)}`).join(" ");
  const area = `${path} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  return (
    <figure className="trend" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Scores over time: ${points.map((p) => p.score).join(", ")}`}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line className="trend-grid" x1={padX} x2={width - padX} y1={y(v)} y2={y(v)} />
            <text className="trend-axis" x={4} y={y(v)} dominantBaseline="middle">{v}</text>
          </g>
        ))}
        <path className="trend-area" d={area} />
        <path className="trend-line" d={path} pathLength={1} />
        {hover !== null && <line className="trend-cross" x1={x(hover)} x2={x(hover)} y1={padY} y2={height - padY} />}
        {points.map((_, i) => (
          <rect key={i} x={x(i) - width / points.length / 2} y={0} width={width / points.length} height={height} fill="transparent" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {points.map((p, i) => (
        <span key={i} className={`trend-pt ${hover === i ? "on" : ""}`} style={{ left: `${(x(i) / width) * 100}%`, top: `${(y(p.score) / height) * 100}%` }} />
      ))}
      {hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / width) * 100}%`, top: `${(y(points[hover].score) / height) * 100}%` }}>
          <strong>{points[hover].score}</strong>
          <span>{points[hover].label}</span>
          {points[hover].sub && <small>{points[hover].sub}</small>}
        </div>
      )}
    </figure>
  );
}

export function Steps({ trail }: { trail: number[] }) {
  // Difficulty over the interview: a step line on a 1-5 scale.
  if (trail.length < 2) return null;
  const width = 260;
  const height = 64;
  const x = (i: number) => 4 + (i * (width - 8)) / (trail.length - 1);
  const y = (v: number) => height - 6 - ((v - 1) / 4) * (height - 12);
  let d = `M${x(0)},${y(trail[0])}`;
  for (let i = 1; i < trail.length; i += 1) d += ` H${x(i)} V${y(trail[i])}`;
  return (
    <svg className="steps" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Difficulty went ${trail.join(", ")}`}>
      {[1, 3, 5].map((v) => <line key={v} className="trend-grid" x1={0} x2={width} y1={y(v)} y2={y(v)} />)}
      <path className="steps-line" d={d} />
    </svg>
  );
}

export function Meter({ value, max = 5, label }: { value: number; max?: number; label: string }) {
  return (
    <div className="meter" role="meter" aria-valuemin={1} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      {Array.from({ length: max }, (_, i) => <span key={i} className={i < value ? "on" : ""} />)}
    </div>
  );
}

export function Bars({ items }: { items: { label: string; value: number; max: number; note?: string }[] }) {
  return (
    <ul className="bars">
      {items.map((item) => (
        <li key={item.label} title={item.note ?? `${item.label}: ${item.value}/${item.max}`}>
          <span className="bars-label">{item.label}</span>
          <span className="bars-track"><span className="bars-fill" style={{ width: `${Math.max(3, (item.value / item.max) * 100)}%` }} /></span>
          <span className="bars-value">{item.value}</span>
        </li>
      ))}
    </ul>
  );
}

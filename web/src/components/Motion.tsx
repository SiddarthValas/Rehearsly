import { useEffect, useMemo, useState } from "react";

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Animate a number from 0 (or its last value) to `value`. */
export function useCountUp(value: number, duration = 1400, delay = 0): number {
  const [shown, setShown] = useState(reduced() ? value : 0);
  useEffect(() => {
    if (reduced()) {
      setShown(value);
      return;
    }
    let frame = 0;
    let start = 0;
    const from = 0;
    const timer = window.setTimeout(() => {
      const tick = (now: number) => {
        if (!start) start = now;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 4);
        setShown(Math.round(from + (value - from) * eased));
        if (t < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [value, duration, delay]);
  return shown;
}

export function CountUp({ value, duration, delay, className }: { value: number; duration?: number; delay?: number; className?: string }) {
  const shown = useCountUp(value, duration, delay);
  return <span className={className}>{shown}</span>;
}

/** Words that rise into place one after another. */
export function Reveal({ text, as: Tag = "h1", className, step = 70 }: { text: string; as?: "h1" | "h2" | "p"; className?: string; step?: number }) {
  return (
    <Tag className={`reveal ${className ?? ""}`} aria-label={text}>
      {text.split(" ").map((word, index) => (
        <span key={index} className="reveal-word" aria-hidden="true" style={{ animationDelay: `${index * step}ms` }}>
          {word}{" "}
        </span>
      ))}
    </Tag>
  );
}

/** A one-off burst of paper confetti in the theme's gel colours. */
export function Confetti({ pieces = 70 }: { pieces?: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.6,
        duration: 2.4 + Math.random() * 1.8,
        drift: (Math.random() - 0.5) * 220,
        spin: (Math.random() - 0.5) * 1080,
        color: ["var(--amber)", "var(--rose)", "var(--violet)", "var(--good)"][i % 4],
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 10,
      })),
    [pieces],
  );
  if (reduced()) return null;
  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((bit, i) => (
        <i
          key={i}
          style={{
            left: `${bit.left}%`,
            width: bit.w,
            height: bit.h,
            background: bit.color,
            animationDelay: `${bit.delay}s`,
            animationDuration: `${bit.duration}s`,
            ["--drift" as string]: `${bit.drift}px`,
            ["--spin" as string]: `${bit.spin}deg`,
          }}
        />
      ))}
    </div>
  );
}

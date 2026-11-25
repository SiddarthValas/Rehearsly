import { useId, type CSSProperties } from "react";

export type LightState = "idle" | "thinking" | "speaking" | "listening" | "off";

/** The ghost light: the single bulb theatres leave burning on an empty stage.
    Here it is the interviewer — it flickers while thinking, swells while speaking,
    and turns cool and reactive while it listens to you. */
export function GhostLight({ state = "idle", level = 0, size = 120, cone = false }: { state?: LightState; level?: number; size?: number; cone?: boolean }) {
  const gid = `glass-${useId().replace(/:/g, "")}`;
  const style = { "--size": `${size}px`, "--level": level.toFixed(3) } as CSSProperties;
  return (
    <div className={`ghost ghost-${state} ${state === "speaking" && level > 0.01 ? "ghost-live" : ""}`} style={style} aria-hidden="true">
      <div className="ghost-halo" />
      {cone && (
        <div className="ghost-cone">
          {Array.from({ length: 9 }, (_, i) => <i key={i} className="mote" style={{ left: `${18 + ((i * 37) % 64)}%`, animationDelay: `${(i * 0.83) % 6}s`, animationDuration: `${6 + (i % 4) * 1.5}s` }} />)}
        </div>
      )}
      <svg className="ghost-bulb" viewBox="0 0 100 140" width={size * 0.62} height={size * 0.87}>
        <defs>
          <radialGradient id={gid} cx="50%" cy="42%" r="55%">
            <stop offset="0%" style={{ stopColor: "var(--glow-core)" }} />
            <stop offset="55%" style={{ stopColor: "var(--glow-mid)" }} />
            <stop offset="100%" style={{ stopColor: "var(--glow-edge)" }} />
          </radialGradient>
        </defs>
        <path className="ghost-glass" d="M50 6C29 6 14 22 14 42c0 15 8 24 14 32 4 6 6 10 6 16h32c0-6 2-10 6-16 6-8 14-17 14-32C86 22 71 6 50 6z" fill={`url(#${gid})`} />
        <path className="ghost-filament" d="M40 84V62l5-8 5 8 5-8 5 8v22" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <rect className="ghost-base" x="34" y="92" width="32" height="7" rx="3" />
        <rect className="ghost-base" x="36" y="101" width="28" height="6" rx="3" />
        <rect className="ghost-base" x="40" y="109" width="20" height="7" rx="3.5" />
        <rect className="ghost-stand" x="47" y="116" width="6" height="24" />
      </svg>
    </div>
  );
}

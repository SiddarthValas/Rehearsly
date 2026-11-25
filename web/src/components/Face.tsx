import { motion, useAnimate, useReducedMotion } from "motion/react";
import { useEffect, useId, useState, type CSSProperties } from "react";
import type { LightState } from "./GhostLight";

export type Mood = "neutral" | "pleased" | "doubtful" | "concerned" | "curious";
export type FaceVariant = "f" | "m";

/** Pick a character to match the voice: Hannah is a woman, Troy and Austin are men. */
export const variantForVoice = (voice?: string): FaceVariant => (voice === "troy" || voice === "austin" ? "m" : "f");

/* Brows (left brow x1,y1 → x2,y2; right brow is mirrored). Small and soft: they carry most of the mood. */
const BROWS: Record<Mood, [number, number, number, number]> = {
  neutral: [37.5, 45, 47.5, 44.2],
  pleased: [37.5, 43.6, 47.5, 42.2],
  doubtful: [37.5, 43.2, 47.5, 44],
  concerned: [37.5, 45.2, 47.5, 42.6], // inner end up: worried, never angry
  curious: [37.5, 41.8, 47.5, 40.6],
};
/* Every mouth uses the same commands (M Q Q Z) so moods morph smoothly into each other. */
const MOUTH: Record<Mood, string> = {
  neutral: "M54 74 Q60 78 66 74 Q60 76 54 74 Z",
  pleased: "M52 72.5 Q60 82 68 72.5 Q60 75 52 72.5 Z",
  doubtful: "M55 75.5 Q60 75 65 73.5 Q60 75 55 75.5 Z",
  concerned: "M55 76 Q60 72.5 65 76 Q60 74 55 76 Z",
  curious: "M57.5 74.5 Q60 78.5 62.5 74.5 Q60 71 57.5 74.5 Z",
};

/** The interviewer as a friendly character that listens: it nods along, smiles at a number,
    raises an eyebrow at a filler word, and looks worried at a non-answer. */
export function Face({
  state = "idle",
  level = 0,
  mood = "neutral",
  nod = 0,
  size = 112,
  variant = "f",
  label = "Interviewer",
  className = "",
}: { state?: LightState; level?: number; mood?: Mood; nod?: number; size?: number; variant?: FaceVariant; label?: string; className?: string }) {
  const reduce = useReducedMotion();
  const uid = useId().replace(/:/g, "");
  const [scope, animate] = useAnimate();
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (!nod || reduce || !scope.current) return;
    void animate(scope.current, { y: [0, 4, -1, 2.5, 0] }, { duration: 0.75, ease: "easeInOut" });
  }, [nod, reduce, animate, scope]);
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 120);
        schedule();
      }, 2400 + Math.random() * 3000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const thinking = state === "thinking";
  const speaking = state === "speaking";
  const listening = state === "listening";
  const shown: Mood = thinking ? "curious" : mood;
  const look = thinking ? { x: 2, y: -2.5 } : listening ? { x: 0, y: 0.5 } : { x: 0, y: 0 };
  const [bx1, by1, bx2, by2] = BROWS[shown];
  const raiseRight = shown === "doubtful";
  const open = speaking ? Math.min(1, level * 2.2) : 0;
  const mouth = open > 0.06
    ? `M54 73.5 Q60 ${76 + open * 9} 66 73.5 Q60 ${72 - open} 54 73.5 Z`
    : MOUTH[shown];
  const spring = { type: "spring", stiffness: 280, damping: 20 } as const;
  const style = { "--face": `${size}px`, "--lvl": level.toFixed(3) } as CSSProperties;
  const f = variant === "f";

  return (
    <div className={`face face-${state} face-${variant} mood-${mood} ${className}`} style={style} role="img" aria-label={`${label}, ${thinking ? "thinking" : speaking ? "speaking" : listening ? "listening" : "waiting"}`}>
      <div className="face-halo" aria-hidden="true" />
      <motion.svg ref={scope} viewBox="0 0 120 120" width={size} height={size} aria-hidden="true" className={listening ? "tilt" : ""}>
        <defs>
          <radialGradient id={`skin-${uid}`} cx="45%" cy="35%" r="70%">
            <stop offset="0%" style={{ stopColor: "var(--skin-hi)" }} />
            <stop offset="100%" style={{ stopColor: "var(--skin-lo)" }} />
          </radialGradient>
          <clipPath id={`clip-${uid}`}><circle cx="60" cy="60" r="58" /></clipPath>
        </defs>
        <g clipPath={`url(#clip-${uid})`}>
          {/* long hair sits behind everything */}
          {f && <path className="face-hair" d="M27 58C23 31 40 15 60 15s37 16 33 43c3 14 7 30 4 44-7 6-17 4-21-2H44c-4 6-14 8-21 2-3-14 1-30 4-44z" />}
          {/* shoulders */}
          <path className="face-shirt" d="M18 122c2-17 17-26 42-26s40 9 42 26z" />
          <path className="face-collar" d={f ? "M50 97q10 9 20 0" : "M51 96l9 9 9-9"} />
          <rect className="face-neck" x="52.5" y="80" width="15" height="17" rx="6" />
          {/* ears and head */}
          {!f && <><ellipse className="face-ear" cx="27.5" cy="60" rx="5" ry="6.5" /><ellipse className="face-ear" cx="92.5" cy="60" rx="5" ry="6.5" /></>}
          <ellipse className="face-head" cx="60" cy="56" rx="33" ry="32" fill={`url(#skin-${uid})`} />
          {/* front hair */}
          {f ? (
            <>
              <path className="face-hair" d="M27 52C26 29 42 18 60 18C79 18 95 30 93 52C89 44 83 38 74 36C70 40 63 41 56 38C48 36 38 40 27 52Z" />
              <circle className="face-clip" cx="81" cy="31" r="3.2" />
            </>
          ) : (
            <path className="face-hair" d="M27 50C26 28 42 19 60 19C78 19 94 28 93 50C90 43 85 39 79 38C72 36 66 38 60 37C52 36 44 37 38 39C33 41 29 45 27 50Z" />
          )}
          {/* cheeks */}
          <ellipse className={`face-cheek ${shown === "pleased" ? "on" : ""}`} cx="39" cy="65" rx="6" ry="3.6" />
          <ellipse className={`face-cheek ${shown === "pleased" ? "on" : ""}`} cx="81" cy="65" rx="6" ry="3.6" />
          {/* eyes: big, dark, glossy */}
          {[45, 75].map((cx, i) => (
            <g key={cx}>
              {blink ? (
                <path className="face-lid" d={`M${cx - 6} 55q6 4 12 0`} />
              ) : (
                <>
                  <motion.ellipse className="face-eye" rx="6" ry="7" animate={{ cx: cx + look.x * 0.6, cy: 55 + look.y * 0.6 }} transition={spring} />
                  <motion.circle className="face-glint" r="2.3" animate={{ cx: cx + 2 + look.x * 0.6, cy: 52.3 + look.y * 0.6 }} transition={spring} />
                  <motion.circle className="face-glint" r="1" animate={{ cx: cx - 2.2 + look.x * 0.6, cy: 58.2 + look.y * 0.6 }} transition={spring} />
                  {f && <path className="face-lash" d={i === 0 ? `M${cx - 5.6} 50.5l-3-2.4` : `M${cx + 5.6} 50.5l3-2.4`} />}
                </>
              )}
            </g>
          ))}
          {/* brows */}
          <motion.line className="face-brow" animate={{ x1: bx1, y1: by1, x2: bx2, y2: by2 }} transition={spring} />
          <motion.line
            className="face-brow"
            animate={raiseRight ? { x1: 72.5, y1: 40.4, x2: 82.5, y2: 41.6 } : { x1: 120 - bx2, y1: by2, x2: 120 - bx1, y2: by1 }}
            transition={spring}
          />
          {/* nose and mouth */}
          <path className="face-nose" d="M59 63q1.5 2 3 0" />
          <motion.path className="face-mouth" animate={{ d: mouth }} transition={{ duration: speaking ? 0.08 : 0.35 }} />
        </g>
        {thinking && (
          <g className="face-dots">
            <circle cx="98" cy="24" r="2.4" /><circle cx="105" cy="16" r="3.1" /><circle cx="112" cy="7" r="3.8" />
          </g>
        )}
      </motion.svg>
      {listening && <div className="face-ring" aria-hidden="true" />}
    </div>
  );
}

import { useEffect, useRef } from "react";

/** The stage behind every page: slow-drifting coloured gel lights, optional sweeping
    spotlight beams, and a soft light that follows the pointer. */
export function Backdrop({ beams = false, quiet = false }: { beams?: boolean; quiet?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || quiet || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        node.style.setProperty("--mx", `${event.clientX}px`);
        node.style.setProperty("--my", `${event.clientY}px`);
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
    };
  }, [quiet]);

  return (
    <div ref={ref} className={`backdrop ${quiet ? "backdrop-quiet" : ""}`} aria-hidden="true">
      <span className="gel gel-a" />
      <span className="gel gel-b" />
      <span className="gel gel-c" />
      {beams && (
        <>
          <span className="beam beam-l" />
          <span className="beam beam-r" />
        </>
      )}
      {!quiet && <span className="follow" />}
    </div>
  );
}

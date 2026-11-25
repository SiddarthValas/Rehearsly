import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

function initial(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d1f1a" : "#eef2ea");
  try {
    localStorage.setItem("rehearsly.theme", theme);
  } catch {
    /* storage unavailable */
  }
}

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };

/** Theme state. Switching uses the View Transitions API to reveal the new theme in a
    circle growing from the toggle, falling back to an instant swap. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => apply(theme), [theme]);

  const toggle = useCallback((origin?: { x: number; y: number }) => {
    const next: Theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    const doc = document as ViewTransitionDoc;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!doc.startViewTransition || reduce || !origin) {
      setTheme(next);
      return;
    }
    const transition = doc.startViewTransition(() => {
      apply(next);
      setTheme(next);
    });
    const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y));
    transition.ready
      .then(() => {
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${origin.x}px ${origin.y}px)`, `circle(${radius}px at ${origin.x}px ${origin.y}px)`] },
          { duration: 620, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
        );
      })
      .catch(() => undefined);
  }, []);

  return { theme, toggle };
}

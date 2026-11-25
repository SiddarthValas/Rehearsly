import { useCallback, useEffect, useState } from "react";
import { api, type Health } from "./lib/api";
import { go, useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Backdrop } from "./components/Backdrop";
import { Moon, Sun } from "./components/Icons";
import { Setup } from "./pages/Setup";
import { Landing } from "./pages/Landing";
import { QuestionBank } from "./pages/QuestionBank";
import { Room } from "./pages/Room";
import { ReviewPage } from "./pages/Review";
import { Study } from "./pages/Study";
import { Mirror } from "./pages/Mirror";
import { Progress } from "./pages/Progress";

function Wordmark() {
  return (
    <a className="wordmark" href="#/" aria-label="Rehearsly home">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="9" r="8" className="wordmark-glow" />
        <path d="M8 9a4 4 0 1 1 8 0c0 1.7-1.1 2.6-1.7 3.6-.3.5-.3.9-.3 1.4h-4c0-.5 0-.9-.3-1.4C9.1 11.6 8 10.7 8 9z" className="wordmark-bulb" />
        <path d="M10 16h4M10.5 18h3M12 18v4M8.5 22h7" className="wordmark-stand" />
      </svg>
      <span>Rehearsly</span>
    </a>
  );
}

function Status({ health, onRetry }: { health: Health | null; onRetry: () => void }) {
  const state = health == null ? "checking" : health.ok ? "ready" : "down";
  const name = health?.model.split("/").pop()?.replace(":latest", "") ?? "";
  const backups = health?.backups ?? [];
  const onBackup = health?.served && health.served !== "Groq" && health.provider === "groq";
  const label = health == null ? "Checking model" : health.ok ? (onBackup ? `${health.served} (backup)` : health.provider === "groq" ? `${name} on Groq` : name) : "Model offline";
  const title = health?.error || (health?.ok
    ? health.provider === "groq"
      ? `Main model: ${health.model} on Groq.${backups.length ? ` Backups if Groq is busy: ${backups.join(", then ")}.` : ""}`
      : `Running locally with ${health.model}`
    : "Check again");
  return (
    <button className={`status status-${state}`} type="button" onClick={onRetry} title={title}>
      <span className="status-dot" />
      {label}
      {backups.length > 0 && !onBackup && <span className="status-backups">+{backups.length} backup{backups.length > 1 ? "s" : ""}</span>}
    </button>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: "dark" | "light"; onToggle: (origin?: { x: number; y: number }) => void }) {
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={`theme-toggle theme-${theme}`}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        onToggle({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      }}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <span className="theme-icon theme-sun"><Sun size={17} /></span>
      <span className="theme-icon theme-moon"><Moon size={17} /></span>
    </button>
  );
}

export function App() {
  const route = useRoute();
  const { theme, toggle } = useTheme();
  const [health, setHealth] = useState<Health | null>(null);

  const check = useCallback(() => {
    api.health().then(setHealth).catch((error: Error) =>
      setHealth({ ok: false, model: "llama3.2", models: [], embeddings: false, error: error.message }),
    );
  }, []);

  useEffect(() => {
    check();
    const timer = window.setInterval(check, 20000);
    return () => window.clearInterval(timer);
  }, [check]);

  const inRoom = route.name === "room" || (route.name === "mirror" && !!route.id);

  return (
    <div className={`shell ${inRoom ? "shell-room" : ""} ${route.name === "home" ? "shell-landing" : ""}`}>
      <Backdrop beams={route.name === "home" || route.name === "review"} quiet={inRoom || route.name === "new"} />
      <header className="topbar">
        <Wordmark />
        <nav className="nav" aria-label="Main">
          <a href="#/" className={route.name === "home" ? "on" : ""}>Overview</a>
          <a href="#/new" className={route.name === "new" || route.name === "room" ? "on" : ""}>Rehearse</a>
          <a href="#/bank" className={route.name === "bank" ? "on" : ""}>Questions</a>
          <a href="#/mirror" className={route.name === "mirror" ? "on" : ""}>Mirror</a>
          <a href="#/progress" className={route.name === "progress" || route.name === "review" ? "on" : ""}>Progress</a>
        </nav>
        <div className="topbar-end">
          <Status health={health} onRetry={check} />
          <ThemeToggle theme={theme} onToggle={toggle} />
          {route.name === "home" && <a className="primary nav-cta" href="#/new">Start</a>}
        </div>
      </header>
      {health && !health.ok && route.name === "new" && (
        <div className="banner" role="status">
          <strong>The local model isn't available.</strong>
          <span>{health.error || "Start Ollama with `ollama serve`, then pull a model with `ollama pull llama3.2`."}</span>
          <button type="button" className="link" onClick={check}>Check again</button>
        </div>
      )}
        <main
          className="page"
          key={route.name + ("id" in route ? route.id : "") + (route.name === "bank" ? route.company + route.role : "")}
        >
          {route.name === "home" && <Landing />}
          {route.name === "new" && <Setup health={health} onStarted={(id) => go(`/room/${id}`)} />}
          {route.name === "room" && <Room id={route.id} health={health} />}
          {route.name === "review" && <ReviewPage id={route.id} />}
          {route.name === "progress" && <Progress />}
          {route.name === "study" && <Study />}
          {route.name === "mirror" && <Mirror id={route.id} health={health} />}
          {route.name === "bank" && <QuestionBank company={route.company} role={route.role} auto={route.auto} />}
        </main>
    </div>
  );
}

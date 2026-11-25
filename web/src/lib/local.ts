/* Browser-side session storage, used when the server runs statelessly (the Vercel deploy).
   Each visitor's interviews live only on their own device. */
import type { History, Session, SessionSummary } from "./api";

const KEY = "rehearsly.sessions.v1";
const MAX = 60;

function read(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Session[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: Session[]) {
  const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX);
  for (let keep = sorted.length; keep > 0; keep -= 5) {
    try {
      localStorage.setItem(KEY, JSON.stringify(sorted.slice(0, keep)));
      return;
    } catch {
      /* quota: drop the oldest few and retry */
    }
  }
}

export const local = {
  all: read,
  get(id: string): Session | undefined {
    return read().find((s) => s.id === id);
  },
  save(session: Session) {
    const list = read().filter((s) => s.id !== session.id);
    list.push(session);
    write(list);
  },
  remove(id: string) {
    write(read().filter((s) => s.id !== id));
  },
  /** Compact history the server uses to avoid repeating earlier questions. */
  prior(limit = 12) {
    return read()
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        fingerprint: (s as Session & { fingerprint?: string }).fingerprint,
        messages: s.messages.filter((m) => m.role === "interviewer").map((m) => ({ role: m.role, kind: m.kind, content: m.content })),
        topics: s.topics.map((t) => ({ planned: t.planned })),
      }));
  },
};

function summary(s: Session): SessionSummary {
  const answered = s.topics.filter((t) => t.status !== "pending");
  const scores = answered.map((t) => t.score ?? 0);
  const computed = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) : null;
  return {
    id: s.id,
    mode: s.mode,
    title: s.title,
    role: s.role,
    persona: s.config.persona,
    drill: Boolean(s.drillOf),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    complete: s.complete,
    reviewed: Boolean(s.review),
    score: answered.length ? s.review?.score ?? computed : null,
    answered: answered.length,
    total: s.topics.length,
    topics: s.topics.map((t) => ({ title: t.title, score: t.score, status: t.status })),
  };
}

export function localHistory(): History {
  const all = read();
  const sessions = all.map(summary);
  const scored = sessions.filter((s) => s.score != null && s.answered);
  const byKindLists: Record<string, number[]> = {};
  all.forEach((s) => s.topics.forEach((t) => t.score != null && (byKindLists[t.kind] ??= []).push(t.score)));
  const byKind = Object.fromEntries(
    Object.entries(byKindLists).map(([k, v]) => [k, Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10]),
  );
  return {
    sessions,
    trend: [...scored].reverse().map((s) => ({ id: s.id, score: s.score as number, at: s.createdAt, title: s.title })),
    byKind,
    stats: {
      count: sessions.length,
      completed: sessions.filter((s) => s.complete).length,
      best: scored.length ? Math.max(...scored.map((s) => s.score as number)) : null,
      average: scored.length ? Math.round(scored.reduce((a, s) => a + (s.score as number), 0) / scored.length) : null,
      answers: sessions.reduce((a, s) => a + s.answered, 0),
    },
  };
}

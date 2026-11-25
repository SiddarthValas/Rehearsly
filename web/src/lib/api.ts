import { local, localHistory } from "./local";

export type Mode = "resume" | "technical" | "behavioral" | "custom" | "hr" | "bank";

export type BankQuestion = { id: string; question: string; subject: string; round: string; date: string; source: string; url: string; scope?: "exact" | "company" | "similar" };

export type Bank = {
  company: string;
  role: string;
  live: boolean;
  summary: string;
  rounds: string[];
  groups: { subject: string; questions: BankQuestion[] }[];
  count: number;
  resolved?: { company: string; program: string; aliases: string[] };
  scopes?: { exact: number; company: number; similar: number };
  sources: { url: string; site: string; title: string }[];
  fetchedAt: number;
};

export type Brief = {
  company: string;
  live: boolean;
  overview: string;
  values: string[];
  culture: string[];
  news: string[];
  products: string[];
  hrFocus: string[];
  questions: string[];
  sources: { url: string; site: string }[];
};
export type Persona = "coach" | "professional" | "bar_raiser";
export type TopicStatus = "pending" | "covered" | "thin" | "skipped";

export type Topic = {
  real?: boolean;
  subject?: string;
  id: string;
  title: string;
  kind: string;
  evidence: string;
  planned: string;
  status: TopicStatus;
  score: number | null;
  followups: number;
};

export type Star = { situation: boolean; task: boolean; action: boolean; result: boolean };

export type GradeCheck = { first: number; second: number; diff: number; agree: boolean; firstBy: string; secondBy: string; reason: string };
export type Trust = {
  answers: number;
  within1: number;
  exact: number;
  meanGap: number;
  correlation: number | null;
  crossModel: boolean;
  judges: string[];
  pairs: { first: number; second: number }[];
};

export type Assessment = {
  check?: GradeCheck;
  status: "covered" | "thin" | "off_topic" | "skipped";
  score: number;
  strength: string;
  gap: string;
  quote: string;
  sharper: string;
  probe: string;
  star: Star;
};

export type Delivery = {
  words: number;
  sentences: number;
  avgSentence: number;
  fillers: Record<string, number>;
  fillerCount: number;
  hedges: Record<string, number>;
  numbers: number;
  ownership: { i: number; we: number };
  durationSec: number | null;
  wpm: number | null;
  clarity: number;
};

export type Message = {
  id: string;
  role: "interviewer" | "candidate";
  content: string;
  kind: "greeting" | "question" | "followup" | "closing" | "answer";
  topic: number | null;
  difficulty: number | null;
  ts: number;
  via?: "text" | "voice";
  delivery?: Delivery;
  assessment?: Assessment;
  streaming?: boolean;
};

export type Profile = {
  name: string;
  headline: string;
  roles: string[];
  projects: string[];
  skills: string[];
  metrics: string[];
  claims: string[];
};

export type Gaps = { matched: string[]; missing: string[]; match: number | null };

export type Competency = { key: string; label: string; score: number };

export type Review = {
  score: number;
  readiness: string;
  provisional: boolean;
  headline: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  plan: { title: string; detail: string }[];
  competencies: Competency[];
  delivery: {
    answers: number;
    words: number;
    avgWords: number;
    fillers: Record<string, number>;
    fillerCount: number;
    wpm: number | null;
    clarity: number | null;
    numbers: number;
  };
  star: Record<keyof Star, number> | null;
  difficultyTrail: number[];
  trust?: Trust | null;
  generatedAt: number;
  session?: Session;
};

export type Session = {
  id: string;
  createdAt: number;
  updatedAt: number;
  mode: Mode;
  title: string;
  role: string;
  model: string;
  config: {
    persona: Persona;
    personaName: string;
    length: string;
    areas?: string[];
    startDifficulty: number;
    focus: string;
    jd: string;
    company?: string;
  };
  profile: Profile;
  gaps: Gaps | null;
  topics: Topic[];
  messages: Message[];
  active: number | null;
  difficulty: number;
  difficultyTrail: number[];
  complete: boolean;
  endedEarly: boolean;
  drillOf?: string;
  review: Review | null;
  source?: string;
  score: number;
  average: number;
  answered: number;
  total: number;
  provisional: boolean;
  covered: number;
  exchanges: number;
};

export type SessionSummary = {
  id: string;
  mode: Mode;
  title: string;
  role: string;
  persona: Persona;
  drill?: boolean;
  createdAt: number;
  updatedAt: number;
  complete: boolean;
  reviewed: boolean;
  score: number | null;
  answered: number;
  total: number;
  topics: { title: string; score: number | null; status: TopicStatus }[];
};

export type History = {
  sessions: SessionSummary[];
  trend: { id: string; score: number; at: number; title: string }[];
  byKind: Record<string, number>;
  stats: { count: number; completed: number; best: number | null; average: number | null; answers: number };
};

export type Health = {
  ok: boolean;
  provider?: "ollama" | "groq";
  search?: boolean;
  tts?: "groq" | "mac" | null;
  voices?: string[];
  backups?: string[];
  served?: string;
  storage?: "server" | "client";
  model: string;
  models: string[];
  embeddings: boolean;
  embedModel?: string;
  error: string;
  whisper?: boolean;
  serverTts?: boolean;
};

export type StreamEvent =
  | { type: "stage"; key: string; label: string; pending?: boolean }
  | { type: "profile"; profile: Profile }
  | { type: "gaps"; gaps: Gaps }
  | { type: "brief"; brief: Brief }
  | { type: "bank"; bank: Bank }
  | { type: "plan"; topics: Topic[] }
  | { type: "session"; session: Session }
  | { type: "answer"; message: Message }
  | { type: "assessment"; messageId: string; assessment: Assessment }
  | { type: "difficulty"; difficulty: number }
  | { type: "start"; message: Message }
  | { type: "token"; text: string }
  | { type: "question"; message: Message }
  | { type: "warning"; detail: string }
  | { type: "done"; session: Session }
  | { type: "error"; detail: string };

async function failure(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    if (typeof body.detail === "string") return new Error(body.detail);
  } catch {
    /* not JSON */
  }
  if (response.status === 502 || response.status === 504) return new Error("The Rehearsly server isn't responding. Is `python run.py` running?");
  return new Error(`Request failed (${response.status}).`);
}

/** POST and consume a server-sent-event stream, calling onEvent for every event. */
async function stream(url: string, init: RequestInit, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new Error("Can't reach the Rehearsly server. Start it with `python run.py`.");
  }
  if (!response.ok || !response.body) throw await failure(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = block.split("\n").find((part) => part.startsWith("data: "));
      if (line) {
        const event = JSON.parse(line.slice(6)) as StreamEvent;
        if (event.type === "error") throw new Error(event.detail);
        onEvent(event);
      }
      cut = buffer.indexOf("\n\n");
    }
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("Can't reach the Rehearsly server. Start it with `python run.py`.");
  }
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

/* Where interviews live: "server" (local install, SQLite) or "client" (hosted deploy,
   each browser keeps its own). Set from /api/health on startup. */
let storage: "server" | "client" = "server";
let storageReady: Promise<void> | null = null;

export function setStorage(mode: "server" | "client" | undefined) {
  storage = mode === "client" ? "client" : "server";
}

async function ensureStorage() {
  if (!storageReady) {
    storageReady = fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((h: Health | null) => setStorage(h?.storage))
      .catch(() => undefined);
  }
  return storageReady;
}

const isClient = async () => {
  await ensureStorage();
  return storage === "client";
};

function stored(id: string): Session {
  const session = local.get(id);
  if (!session) throw new Error("That interview isn't saved in this browser.");
  return session;
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export type StudyItem = { id: string; mode: string; topic: string; question: string; answer: string; tier?: "strong" | "medium" | "weak" | "none" };
export type StudyPair = { better: string; worse: string; what: string };
export type StudyGrade = { id: string; complete?: boolean; score: number; status: string; first: number | null; second: number | null; firstBy: string; secondBy: string };

export type MirrorFlaw = "none" | "bluff" | "ramble" | "vague" | "dodge" | "contradiction";
export type MirrorCandidate = { name: string; headline: string; resume: string[]; voice: string };
export type AnswerNotes = { structure: string; moves: string[] };
export type MirrorTurn = { id: string; question: string; answer: string; sealedTurn: string; verdict: "solid" | "weak" | null; tag: MirrorFlaw | null; notes?: AnswerNotes };
export type MirrorSession = {
  id: string;
  kind?: "candidate" | "self";
  role: string;
  createdAt: number;
  candidate: MirrorCandidate;
  suggested: string[];
  sealed: string;
  turns: MirrorTurn[];
  reveal: MirrorReveal | null;
};
export type MirrorReveal = {
  persona: { key: string; label: string; about: string };
  truth: string[];
  turns: { turn: number; question: string; answer: string; flaw: MirrorFlaw; flawLabel: string; truth: "solid" | "weak"; verdict: "solid" | "weak" | null; correct: boolean | null; tagRight: boolean; why: string }[];
  stats: { judged: number; total: number; flawed: number; caught: number; falseAlarms: number; accuracy: number; detection: number; overall: number };
  questioning: number;
  strengths: string[];
  improvements: string[];
  missedFollowup: string;
};
export const api = {
  mirrorStart: (role: string) => json<{ candidate: MirrorCandidate; suggested: string[]; role: string; sealed: string }>("/api/mirror/start", postJson({ role })),
  mirrorSelf: (form: FormData) => json<{ candidate: MirrorCandidate; suggested: string[]; role: string; sealed: string }>("/api/mirror/self", { method: "POST", body: form }),
  mirrorAnswer: async (sealed: string, question: string, history: MirrorTurn[], onToken: (text: string) => void) => {
    let done: { answer: string; sealedTurn: string; notes?: AnswerNotes } | null = null;
    await stream(
      "/api/mirror/answer",
      postJson({ sealed, question, history: history.map(({ question, answer, sealedTurn }) => ({ question, answer, sealedTurn })) }),
      (event) => {
        if (event.type === "token") onToken(event.text);
        else if ((event as { type: string }).type === "done") done = event as unknown as { answer: string; sealedTurn: string; notes?: AnswerNotes };
      },
    );
    if (!done) throw new Error("The candidate didn't answer. Try again.");
    return done as { answer: string; sealedTurn: string; notes?: AnswerNotes };
  },
  mirrorReveal: (sealed: string, turns: MirrorTurn[]) =>
    json<MirrorReveal>("/api/mirror/reveal", postJson({ sealed, turns: turns.map(({ question, answer, sealedTurn, verdict, tag }) => ({ question, answer, sealedTurn, verdict, tag })) })),
  studyItems: () => json<{ items: StudyItem[]; pairs: StudyPair[]; rubric: { range: string; meaning: string }[] }>("/api/study/items"),
  studyGrade: (ids: string[]) => json<{ grades: StudyGrade[] }>("/api/study/grade", postJson({ ids })),
  health: async () => {
    const health = await json<Health>("/api/health");
    setStorage(health.storage);
    storageReady = Promise.resolve();
    return health;
  },
  history: async () => ((await isClient()) ? localHistory() : json<History>("/api/sessions")),
  session: async (id: string) => ((await isClient()) ? stored(id) : json<Session>(`/api/sessions/${id}`)),
  remove: async (id: string) => {
    if (await isClient()) {
      local.remove(id);
      return { ok: true };
    }
    return json<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" });
  },
  hint: async (id: string) =>
    json<{ hint: string; structure: string[] }>(`/api/sessions/${id}/hint`, (await isClient()) ? postJson({ session: stored(id) }) : { method: "POST" }),
  drill: async (id: string) => {
    if (await isClient()) {
      const next = await json<Session>(`/api/sessions/${id}/drill`, postJson({ session: stored(id), prior: local.prior() }));
      local.save(next);
      return next;
    }
    return json<Session>(`/api/sessions/${id}/drill`, { method: "POST" });
  },
  end: async (id: string) => {
    if (await isClient()) {
      const next = await json<Session>(`/api/sessions/${id}/end`, postJson({ session: stored(id) }));
      local.save(next);
      return next;
    }
    return json<Session>(`/api/sessions/${id}/end`, { method: "POST" });
  },
  review: async (id: string, refresh = false) => {
    const url = `/api/sessions/${id}/review${refresh ? "?refresh=true" : ""}`;
    if (await isClient()) {
      const result = await json<Review>(url, postJson({ session: stored(id) }));
      if (result.session) local.save(result.session);
      return result;
    }
    return json<Review>(url, { method: "POST" });
  },
  create: async (form: FormData, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) => {
    const client = await isClient();
    if (client) form.set("prior", JSON.stringify(local.prior()));
    return stream(
      "/api/sessions",
      { method: "POST", body: form },
      (event) => {
        if (client && event.type === "session") local.save(event.session);
        onEvent(event);
      },
      signal,
    );
  },
  answer: async (
    id: string,
    body: { content: string; duration?: number | null; via?: "text" | "voice" },
    onEvent: (event: StreamEvent) => void,
  ) => {
    const client = await isClient();
    const payload = client ? { ...body, session: stored(id) } : body;
    return stream(`/api/sessions/${id}/answer`, postJson(payload), (event) => {
      if (client && event.type === "done") local.save(event.session);
      onEvent(event);
    });
  },
  questionBank: (body: { company: string; role: string; refresh?: boolean }, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) =>
    stream("/api/research/questions", postJson(body), onEvent, signal),
  transcribe: async (blob: Blob) => {
    const form = new FormData();
    form.set("audio", blob, "answer.wav");
    return json<{ text: string; duration: number }>("/api/transcribe", { method: "POST", body: form });
  },
};

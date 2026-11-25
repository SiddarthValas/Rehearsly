import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type StudyGrade, type StudyItem, type StudyPair } from "../lib/api";
import { agreement, kappaLabel, mean, spearman, type Agreement } from "../lib/agreement";
import { GhostLight } from "../components/GhostLight";

/* Grading study: people rate the same 24 answers blind, then we measure how closely the AI graders
   agree with them, next to how closely the people agree with each other. Everything stays in this browser;
   ratings from other people come in as a short share code or a file. */

const KEY = "rehearsly.study.v1";
type Rater = { id: string; name: string; scores: Record<string, number> };
type Saved = { raters: Rater[]; ai: Record<string, StudyGrade>; aiAt?: number; aiPrev?: Record<string, StudyGrade> };

function load(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    // Only grades where both graders answered are kept (older runs could include single-grader fallbacks).
    const clean = (grades: unknown) =>
      grades && typeof grades === "object" ? Object.fromEntries(Object.entries(grades as Record<string, StudyGrade>).filter(([, g]) => g && g.complete === true)) : {};
    return { raters: Array.isArray(saved.raters) ? saved.raters : [], ai: clean(saved.ai), aiAt: saved.aiAt, aiPrev: clean(saved.aiPrev) };
  } catch {
    return { raters: [], ai: {} };
  }
}
function persist(state: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: the study still works for this visit */
  }
}

const newId = () => Math.random().toString(36).slice(2, 10);
const DIGITS = "0123456789a"; // a = 10

/* Share code: RS1.<name in base64url>.<one character per answer, "-" if unrated> */
function toCode(rater: Rater, items: StudyItem[]) {
  const name = btoa(unescape(encodeURIComponent(rater.name))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `RS1.${name}.${items.map((item) => (item.id in rater.scores ? DIGITS[rater.scores[item.id]] : "-")).join("")}`;
}
function fromCode(code: string, items: StudyItem[]): Rater | null {
  const match = code.trim().match(/^RS1\.([A-Za-z0-9_-]+)\.([0-9a-]+)$/);
  if (!match || match[2].length !== items.length) return null;
  let name = "";
  try {
    name = decodeURIComponent(escape(atob(match[1].replace(/-/g, "+").replace(/_/g, "/"))));
  } catch {
    return null;
  }
  const scores: Record<string, number> = {};
  items.forEach((item, i) => {
    const at = DIGITS.indexOf(match[2][i]);
    if (at >= 0) scores[item.id] = at;
  });
  return { id: newId(), name: name.slice(0, 40) || "Rater", scores };
}

const avg = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

export function Study() {
  const [items, setItems] = useState<StudyItem[] | null>(null);
  const [rubric, setRubric] = useState<{ range: string; meaning: string }[]>([]);
  const [pairs, setPairs] = useState<StudyPair[]>([]);
  const [error, setError] = useState("");
  const [state, setState] = useState<Saved>(load);
  const [rating, setRating] = useState<string | null>(null); // rater id being rated
  const [name, setName] = useState("");
  const [grading, setGrading] = useState<{ done: number; total: number; waiting?: number } | null>(null);
  const [gradeError, setGradeError] = useState("");
  const [importText, setImportText] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api.studyItems().then((data) => { setItems(data.items); setRubric(data.rubric); setPairs(data.pairs ?? []); }).catch((reason: Error) => setError(reason.message));
  }, []);

  const update = useCallback((next: (prev: Saved) => Saved) => {
    setState((prev) => {
      const value = next(prev);
      persist(value);
      return value;
    });
  }, []);

  function addRater(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const rater = { id: newId(), name: trimmed.slice(0, 40), scores: {} };
    update((prev) => ({ ...prev, raters: [...prev.raters, rater] }));
    setName("");
    setRating(rater.id);
  }

  function importRatings(raters: Rater[]) {
    if (!raters.length) {
      setNotice("That isn't a Rehearsly share code. It starts with RS1.");
      return;
    }
    update((prev) => {
      const kept = prev.raters.filter((r) => !raters.some((n) => n.name.toLowerCase() === r.name.toLowerCase()));
      return { ...prev, raters: [...kept, ...raters] };
    });
    setNotice(`Added ratings from ${raters.map((r) => r.name).join(", ")}.`);
    setImportText("");
  }

  async function importFile(file: File) {
    if (!items) return;
    try {
      const data = JSON.parse(await file.text());
      const list = (Array.isArray(data.raters) ? data.raters : [data]).filter((r: Rater) => r && typeof r.name === "string" && r.scores && typeof r.scores === "object");
      importRatings(list.map((r: Rater) => ({ id: newId(), name: r.name.slice(0, 40), scores: Object.fromEntries(Object.entries(r.scores).filter(([k, v]) => items.some((i) => i.id === k) && Number.isInteger(v) && v >= 0 && v <= 10)) })));
    } catch {
      setNotice("Couldn't read that file. Use a ratings file exported from this page.");
    }
  }

  async function gradeAll() {
    if (!items) return;
    const missing = items.filter((item) => !state.ai[item.id]).map((item) => item.id);
    let todo = missing.length ? missing : items.map((item) => item.id);
    if (!missing.length) update((prev) => ({ ...prev, aiPrev: prev.ai, ai: {} })); // keep the last full run to measure stability
    setGradeError("");
    const total = todo.length;
    let done = 0;
    setGrading({ done, total });
    // One answer at a time keeps both graders inside the free per-minute limits. A grade only counts when both
    // graders answered; answers that hit a busy grader are retried after a pause instead of keeping a fallback grade.
    for (let attempt = 0; attempt < 3 && todo.length; attempt++) {
      if (attempt > 0) {
        setGrading({ done, total, waiting: 30 });
        await new Promise((resolve) => window.setTimeout(resolve, 30000));
      }
      const retry: string[] = [];
      for (const id of todo) {
        try {
          const { grades } = await api.studyGrade([id]);
          const grade = grades[0];
          if (grade && grade.complete !== false) {
            update((prev) => ({ ...prev, ai: { ...prev.ai, [grade.id]: grade }, aiAt: Date.now() }));
            done += 1;
          } else {
            retry.push(id);
          }
        } catch (reason) {
          if (/busy|quota|rate|429/i.test((reason as Error).message)) retry.push(id);
          else {
            setGradeError(`${(reason as Error).message} The grades so far are saved. Press the button again to finish the rest.`);
            setGrading(null);
            return;
          }
        }
        setGrading({ done, total });
      }
      todo = retry;
    }
    if (todo.length) setGradeError(`${todo.length} answer${todo.length === 1 ? "" : "s"} couldn't be graded by both AI graders (free limits). Wait a minute and press the button again to finish.`);
    setGrading(null);
  }

  function download(filename: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  const results = useMemo(() => (items ? analyse(items, state) : null), [items, state]);

  if (!items) {
    return error ? (
      <div className="empty"><GhostLight size={100} state="off" /><h1>Couldn't load the study.</h1><p>{error}</p></div>
    ) : (
      <div className="loading"><GhostLight size={100} state="thinking" /><p>Loading the answer set…</p></div>
    );
  }

  const active = state.raters.find((r) => r.id === rating);
  if (active) {
    return (
      <Rate
        items={items}
        rubric={rubric}
        rater={active}
        onScore={(itemId, score) => update((prev) => ({ ...prev, raters: prev.raters.map((r) => (r.id === active.id ? { ...r, scores: { ...r.scores, [itemId]: score } } : r)) }))}
        onClose={() => setRating(null)}
      />
    );
  }

  const graded = items.filter((item) => state.ai[item.id]).length;

  return (
    <div className="study">
      <header className="study-head">
        <h1>Grading study</h1>
        <p className="lede">
          Can the AI grader be trusted? {items.length} fixed interview answers, written from excellent to empty, are graded
          by the same two AI graders a live interview uses. Automatic checks test whether it tells good answers from bad
          and gives the same grade twice. People can also rate the answers blind and compare.
        </p>
      </header>

      <div className="study-grid">
        <section className="panel">
          <h2>AI grades</h2>
          <p className="muted">
            The same two graders a live interview uses grade every answer independently. The grade you see in an interview is their average.
          </p>
          <div className="study-ai">
            <strong>{grading ? `${grading.done} of ${grading.total}` : `${graded} of ${items.length}`}</strong>
            <span className="muted small">{grading ? (grading.waiting ? `AI busy, retrying in ${grading.waiting} s…` : "grading…") : graded ? `graded${state.aiAt ? " " + new Date(state.aiAt).toLocaleString() : ""}` : "not graded yet"}</span>
            {grading && <span className="study-bar" aria-hidden="true"><i style={{ width: `${(100 * grading.done) / grading.total}%` }} /></span>}
          </div>
          <button type="button" className="primary" disabled={!!grading} onClick={gradeAll}>
            {graded === 0 ? "Grade all answers with AI" : graded < items.length ? "Grade the rest" : "Grade again"}
          </button>
          <p className="muted small">Takes 2 to 4 minutes on the free AI tiers. Grading again shows how stable the AI is from one run to the next.</p>
          {gradeError && <p className="study-notice error" role="alert">{gradeError}</p>}
        </section>
        <section className="panel">
          <h2>People <span className="muted small">(optional, strongest evidence)</span></h2>
          {state.raters.length > 0 ? (
            <ul className="study-raters">
              {state.raters.map((rater) => {
                const count = items.filter((item) => item.id in rater.scores).length;
                return (
                  <li key={rater.id}>
                    <span className="study-rater-name">{rater.name}</span>
                    <span className="muted small">{count} of {items.length} rated</span>
                    <span className="study-rater-actions">
                      <button type="button" className="link" onClick={() => setRating(rater.id)}>{count < items.length ? (count ? "Continue" : "Start") : "Review"}</button>
                      {count > 0 && (
                        <button type="button" className="link" onClick={() => { void navigator.clipboard?.writeText(toCode(rater, items)); setNotice(`Copied ${rater.name}'s share code.`); }}>Copy code</button>
                      )}
                      <button type="button" className="link danger" onClick={() => update((prev) => ({ ...prev, raters: prev.raters.filter((r) => r.id !== rater.id) }))}>Remove</button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">
              The automatic checks below need no people. Adding even two raters also shows how the AI compares with
              human judgement, and how much humans agree with each other.
            </p>
          )}
          <form className="study-add" onSubmit={addRater}>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rater's name" aria-label="Rater's name" maxLength={40} />
            <button type="submit" className="primary" disabled={!name.trim()}>Start rating</button>
          </form>
          <details className="study-import">
            <summary>Add ratings from someone on another device</summary>
            <p className="muted small">
              They open this page on their own phone or laptop, rate the answers, press <em>Copy code</em> and send it to you.
              Paste one or more codes here.
            </p>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={3} placeholder="RS1.…" aria-label="Share codes" />
            <div className="study-import-actions">
              <button type="button" className="ghost-btn" disabled={!importText.trim()} onClick={() => importRatings(importText.split(/\s+/).map((code) => fromCode(code, items)).filter((r): r is Rater => !!r))}>Add codes</button>
              <label className="ghost-btn">
                Or choose a ratings file
                <input type="file" accept="application/json,.json" hidden onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ""; }} />
              </label>
            </div>
          </details>
          {notice && <p className="study-notice" role="status">{notice}</p>}
        </section>

      </div>

      {graded >= 8 ? (
        <AutoChecks items={items} pairs={pairs} state={state} />
      ) : (
        <section className="panel">
          <h2>Automatic checks</h2>
          <p className="muted">Press <em>Grade all answers with AI</em> above. The checks appear when the grading finishes.</p>
        </section>
      )}
      {results && <Results items={items} state={state} results={results} onDownload={download} />}
    </div>
  );
}

/* ---------------------------------------------------------------- rating one answer at a time */

function Rate({ items, rubric, rater, onScore, onClose }: {
  items: StudyItem[]; rubric: { range: string; meaning: string }[]; rater: Rater;
  onScore: (itemId: string, score: number) => void; onClose: () => void;
}) {
  const firstOpen = items.findIndex((item) => !(item.id in rater.scores));
  const [index, setIndex] = useState(firstOpen >= 0 ? firstOpen : 0);
  const item = items[index];
  const current = rater.scores[item.id];
  const count = items.filter((i) => i.id in rater.scores).length;

  const pick = useCallback((score: number) => {
    onScore(item.id, score);
    if (index < items.length - 1) window.setTimeout(() => setIndex((i) => Math.min(i + 1, items.length - 1)), 220);
  }, [index, item.id, items.length, onScore]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (/^[0-9]$/.test(event.key)) pick(Number(event.key));
      else if (event.key === "t" || event.key === "T") pick(10);
      else if (event.key === "ArrowRight") setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (event.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pick, items.length]);

  return (
    <div className="study study-rate">
      <header className="study-rate-head">
        <button type="button" className="link" onClick={onClose}>Back to the study</button>
        <span className="muted">{rater.name} · answer {index + 1} of {items.length} · {count} rated</span>
      </header>
      <span className="study-bar" aria-hidden="true"><i style={{ width: `${(100 * count) / items.length}%` }} /></span>

      <article className="panel study-card">
        <p className="study-meta">{item.topic} <span className="muted">({item.mode === "hr" ? "HR" : item.mode})</span></p>
        <h2 className="study-q">{item.question}</h2>
        <blockquote className="study-a">{item.answer}</blockquote>

        <fieldset className="study-scale">
          <legend>Your grade, 0 to 10</legend>
          <div className="study-scores">
            {Array.from({ length: 11 }, (_, score) => (
              <button key={score} type="button" className={`study-score ${current === score ? "on" : ""}`} aria-pressed={current === score} onClick={() => pick(score)}>
                {score}
              </button>
            ))}
          </div>
          <p className="muted small">Keys: 0 to 9, T for 10, arrows to move.</p>
        </fieldset>

        <dl className="study-rubric">
          {rubric.map((row) => (
            <div key={row.range}><dt>{row.range}</dt><dd>{row.meaning}</dd></div>
          ))}
        </dl>

        <div className="study-nav">
          <button type="button" className="ghost-btn" disabled={index === 0} onClick={() => setIndex(index - 1)}>Previous</button>
          {index < items.length - 1 ? (
            <button type="button" className="ghost-btn" onClick={() => setIndex(index + 1)}>Next</button>
          ) : (
            <button type="button" className="primary" onClick={onClose}>Finish</button>
          )}
        </div>
      </article>
    </div>
  );
}

/* ---------------------------------------------------------------- checks that need no people */

const TIER_ORDER = ["strong", "medium", "weak", "none"] as const;
const TIER_LABEL: Record<string, string> = { strong: "Strong", medium: "Middling", weak: "Weak", none: "No real answer" };
const TIER_RANK: Record<string, number> = { strong: 3, medium: 2, weak: 1, none: 0 };

function AutoChecks({ items, pairs, state }: { items: StudyItem[]; pairs: StudyPair[]; state: Saved }) {
  const graded = items.filter((item) => state.ai[item.id] && item.tier);
  const bands = TIER_ORDER.map((tier) => {
    const scores = graded.filter((item) => item.tier === tier).map((item) => state.ai[item.id].score);
    return { tier, n: scores.length, mean: scores.length ? avg(scores) : null, min: scores.length ? Math.min(...scores) : null, max: scores.length ? Math.max(...scores) : null };
  }).filter((band) => band.n > 0);
  const means = bands.map((band) => band.mean as number);
  const ordered = means.every((value, i) => i === 0 || value < means[i - 1]);
  const rho = spearman(graded.map((item) => TIER_RANK[item.tier as string]), graded.map((item) => state.ai[item.id].score));

  const contests = pairs
    .filter((pair) => state.ai[pair.better] && state.ai[pair.worse])
    .map((pair) => ({ ...pair, high: state.ai[pair.better].score, low: state.ai[pair.worse].score, won: state.ai[pair.better].score > state.ai[pair.worse].score }));
  const wins = contests.filter((c) => c.won).length;

  const both = graded.filter((item) => state.ai[item.id].first != null && state.ai[item.id].second != null);
  // Agreement only means something between different models, so same-provider pairs are left out.
  const cross = both.filter((item) => state.ai[item.id].firstBy && state.ai[item.id].firstBy !== state.ai[item.id].secondBy);
  const judges = agreement(cross.map((item) => state.ai[item.id].first as number), cross.map((item) => state.ai[item.id].second as number));
  const prev = state.aiPrev ?? {};
  const again = items.filter((item) => prev[item.id] && state.ai[item.id]);
  const stability = again.length >= 8 ? agreement(again.map((item) => prev[item.id].score), again.map((item) => state.ai[item.id].score)) : null;

  const mix = new Map<string, number>();
  for (const item of both) {
    const key = `${state.ai[item.id].firstBy} + ${state.ai[item.id].secondBy}`;
    mix.set(key, (mix.get(key) ?? 0) + 1);
  }
  const names = [...mix.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} (${n})`).join(", ") || "the two graders";

  const verdict = [
    ordered ? "It puts every quality band in the right order" : "It does not keep the quality bands in order",
    contests.length ? `picks the better answer in ${wins} of ${contests.length} head-to-head pairs` : "",
    rho != null ? `and its grades follow answer quality with a rank correlation of ${rho}` : "",
  ].filter(Boolean).join(", ") + ".";

  return (
    <section className="panel study-auto">
      <h2>Automatic checks</h2>
      <p className="study-headline">{verdict}</p>
      <dl className="stats study-stats">
        <div><dt>Better answer scored higher</dt><dd>{wins}<small> of {contests.length}</small></dd></div>
        <div><dt>Rank correlation with quality</dt><dd>{rho ?? "–"}</dd></div>
        <div><dt>Two different AI models agree (kappa)</dt><dd>{judges.n ? judges.kappa ?? "–" : "–"}<small>{judges.n ? ` ${judges.within1}% within 1, ${judges.n} answers` : " no cross-model pairs yet"}</small></dd></div>
        <div><dt>Same grade on a second run (kappa)</dt><dd>{stability ? stability.kappa ?? "–" : "–"}<small>{stability ? ` ${stability.within1}% within 1` : " grade again to measure"}</small></dd></div>
      </dl>

      <div className="study-auto-grid">
        <div>
          <h3>Average grade by answer quality</h3>
          <table className="study-table">
            <thead><tr><th scope="col">Written as</th><th scope="col">Answers</th><th scope="col">Average</th><th scope="col">Range</th></tr></thead>
            <tbody>
              {bands.map((band) => (
                <tr key={band.tier}>
                  <th scope="row">{TIER_LABEL[band.tier]}</th>
                  <td>{band.n}</td>
                  <td><strong>{(band.mean as number).toFixed(1)}</strong></td>
                  <td>{band.min === band.max ? band.min : `${band.min} to ${band.max}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3>Same question, better answer</h3>
          <ul className="study-pairs">
            {contests.map((c) => (
              <li key={c.better} className={c.won ? "won" : "lost"}>
                <span>{c.what}</span>
                <strong>{c.high} vs {c.low}</strong>
                <em>{c.won ? "Correct" : "Wrong order"}</em>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="muted small">
        Graders (first + second, answers): {names}. Answers scored 0 by rule (a skip or a non-answer) use no AI. The quality bands were set when the answers were written, by the app's developer, so these
        checks show the grader can tell good answers from bad ones. They are not a substitute for people's judgement:
        add raters above for that.
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- analysis */

type Analysis = {
  rows: { label: string; note: string; value: Agreement | null; key: string }[];
  headline: string;
  judges: { first: string; second: string };
  people: Rater[];
};

function analyse(items: StudyItem[], state: Saved): Analysis | null {
  const graded = items.filter((item) => state.ai[item.id]);
  const people = state.raters.filter((r) => items.filter((item) => item.id in r.scores).length >= 8);
  if (graded.length < 8 || !people.length) return null;

  const most = (pick: (g: StudyGrade) => string) => {
    const counts = new Map<string, number>();
    for (const g of graded.map((item) => state.ai[item.id])) {
      const name = pick(g);
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  };
  const judges = { first: most((g) => g.firstBy) || "First grader", second: most((g) => g.secondBy) || "Second grader" };

  const versus = (rater: Rater, pick: (g: StudyGrade) => number | null) => {
    const a: number[] = [], b: number[] = [];
    for (const item of graded) {
      const ai = pick(state.ai[item.id]);
      if (item.id in rater.scores && ai != null) { a.push(rater.scores[item.id]); b.push(ai); }
    }
    return agreement(a, b);
  };
  const final = mean(people.map((r) => versus(r, (g) => g.score)));
  const first = mean(people.map((r) => versus(r, (g) => g.first)));
  const second = mean(people.map((r) => versus(r, (g) => g.second)));

  const pairs: Agreement[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const a: number[] = [], b: number[] = [];
      for (const item of items) {
        if (item.id in people[i].scores && item.id in people[j].scores) { a.push(people[i].scores[item.id]); b.push(people[j].scores[item.id]); }
      }
      pairs.push(agreement(a, b));
    }
  }
  const human = mean(pairs);
  const both = graded.filter((item) => state.ai[item.id].first != null && state.ai[item.id].second != null);
  const machines = agreement(both.map((item) => state.ai[item.id].first as number), both.map((item) => state.ai[item.id].second as number));

  const per = people.length > 1 ? "average over every person" : people[0].name;
  const rows = [
    { key: "final", label: "Rehearsly's grade vs a person", note: per, value: final },
    { key: "first", label: `${judges.first} vs a person`, note: per, value: first },
    { key: "second", label: `${judges.second} vs a person`, note: per, value: second },
    { key: "human", label: "Person vs person", note: people.length > 1 ? "every pair of people" : "needs a second person", value: human },
    { key: "machines", label: `${judges.first} vs ${judges.second}`, note: "the two AI graders", value: machines },
  ];

  let headline: string;
  const k = final?.kappa ?? null;
  const h = human?.kappa ?? null;
  if (k == null) headline = "Not enough overlapping answers yet to measure agreement.";
  else if (h == null) headline = `The AI's grades match ${people[0].name}'s with a kappa of ${k} (${kappaLabel(k)} agreement). Add a second person to see how much people agree with each other.`;
  else if (k >= h - 0.05) headline = `The AI agrees with a person about as well as two people agree with each other: kappa ${k} for AI vs person, ${h} for person vs person.`;
  else headline = `The AI agrees with people less closely than they agree with each other: kappa ${k} for AI vs person, ${h} for person vs person. Treat its grades as a guide, not a verdict.`;

  return { rows, headline, judges, people };
}

function Results({ items, state, results, onDownload }: {
  items: StudyItem[]; state: Saved; results: Analysis; onDownload: (name: string, text: string, type: string) => void;
}) {
  const { rows, headline, judges, people } = results;
  const lines = items
    .filter((item) => state.ai[item.id])
    .map((item, index) => {
      const ratings = people.map((p) => p.scores[item.id]).filter((s): s is number => s != null);
      const human = ratings.length ? avg(ratings) : null;
      const ai = state.ai[item.id];
      return { item, index, ratings, human, ai, gap: human == null ? null : ai.score - human };
    });

  function csv() {
    const head = ["id", "mode", "topic", "question", ...people.map((p) => p.name), "people_mean", judges.first, judges.second, "rehearsly"];
    const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const body = lines.map((l) => [l.item.id, l.item.mode, l.item.topic, l.item.question, ...people.map((p) => p.scores[l.item.id] ?? ""), l.human == null ? "" : l.human.toFixed(2), l.ai.first ?? "", l.ai.second ?? "", l.ai.score].map(cell).join(","));
    onDownload("rehearsly-grading-study.csv", [head.map(cell).join(","), ...body].join("\n"), "text/csv");
  }

  return (
    <>
      <section className="panel study-results">
        <div className="study-results-head">
          <h2>Results</h2>
          <button type="button" className="ghost-btn" onClick={csv}>Download as CSV</button>
        </div>
        <p className="study-headline">{headline}</p>
        <div className="study-table-wrap">
          <table className="study-table">
            <thead>
              <tr>
                <th scope="col">Comparison</th>
                <th scope="col">Answers</th>
                <th scope="col">Exact</th>
                <th scope="col">Within 1</th>
                <th scope="col">Average gap</th>
                <th scope="col">Pearson r</th>
                <th scope="col">Kappa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className={row.key === "final" ? "key" : row.key === "human" ? "bar" : ""}>
                  <th scope="row">{row.label}<small>{row.note}</small></th>
                  {row.value && row.value.n > 0 ? (
                    <>
                      <td>{row.value.n}</td>
                      <td>{row.value.exact}%</td>
                      <td>{row.value.within1}%</td>
                      <td>{row.value.mae} pts</td>
                      <td>{row.value.pearson ?? "–"}</td>
                      <td>{row.value.kappa ?? "–"}<small>{kappaLabel(row.value.kappa)}</small></td>
                    </>
                  ) : (
                    <td colSpan={6} className="muted">–</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Kappa is quadratic weighted Cohen's kappa, the usual measure for graded essays: 1 is perfect, 0 is no better than chance,
          and a 2-point miss counts four times as much as a 1-point miss. Person vs person is the realistic ceiling for any grader.
        </p>
      </section>

      <section className="panel">
        <h2>Answer by answer</h2>
        <p className="muted small">Rows where the AI and the people differ by 3 or more points are marked. Open a row to read the answer.</p>
        <div className="study-table-wrap">
          <table className="study-table study-items">
            <thead>
              <tr>
                <th scope="col">Answer</th>
                <th scope="col">{people.length > 1 ? "People (avg)" : people[0].name}</th>
                <th scope="col">{judges.first}</th>
                <th scope="col">{judges.second}</th>
                <th scope="col">Rehearsly</th>
                <th scope="col">Gap</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.item.id} className={l.gap != null && Math.abs(l.gap) >= 3 ? "split" : ""}>
                  <th scope="row">
                    <details>
                      <summary><b>{l.index + 1}.</b> {l.item.question}</summary>
                      <p>{l.item.answer}</p>
                    </details>
                  </th>
                  <td>{l.human == null ? "–" : Number.isInteger(l.human) ? l.human : l.human.toFixed(1)}{people.length > 1 && l.ratings.length > 0 && <small>{l.ratings.join(", ")}</small>}</td>
                  <td>{l.ai.first ?? "–"}</td>
                  <td>{l.ai.second ?? "–"}</td>
                  <td><strong>{l.ai.score}</strong></td>
                  <td>{l.gap == null ? "–" : `${l.gap > 0 ? "+" : ""}${Number.isInteger(l.gap) ? l.gap : l.gap.toFixed(1)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

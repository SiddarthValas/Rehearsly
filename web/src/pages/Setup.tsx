import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Brief, type Gaps, type Health, type History, type Mode, type Persona, type Profile, type Topic } from "../lib/api";
import { DIFFICULTY_LABEL, KIND_LABEL } from "../lib/format";
import { GhostLight } from "../components/GhostLight";
import { Reveal } from "../components/Motion";
import { unlockAudio } from "../lib/voice";
import { Check, Clock, Close, File as FileIcon, Upload } from "../components/Icons";
import * as I from "../components/Icons";

const MODES: { id: Mode; title: string; line: string; tape: string }[] = [
  { id: "resume", title: "My resume", line: "Questions about what you've actually built. Add a job description and it hunts for your gaps.", tape: "blue" },
  { id: "technical", title: "A job description", line: "A technical round built from each requirement in the posting.", tape: "amber" },
  { id: "behavioral", title: "Behavioral round", line: "Real stories about ownership, conflict and pressure, graded on STAR.", tape: "pink" },
  { id: "hr", title: "HR round", line: "Name the company. It researches their values, culture and recent news, then interviews you like their recruiter.", tape: "amber" },
  { id: "custom", title: "Something else", line: "Name a subject and an interviewer. System design with a staff engineer, say.", tape: "mint" },
];

const PERSONAS: { id: Persona; title: string; line: string }[] = [
  { id: "coach", title: "Supportive coach", line: "Warm, encouraging, one follow-up." },
  { id: "professional", title: "Neutral professional", line: "Polite, concise, no praise." },
  { id: "bar_raiser", title: "Bar-raiser", line: "Terse, skeptical, keeps digging." },
];

const LENGTHS = [
  { id: "short", label: "Short", count: 4, time: "about 8 min" },
  { id: "medium", label: "Medium", count: 6, time: "about 12 min" },
  { id: "long", label: "Long", count: 8, time: "about 18 min" },
];

const AREAS: Record<Mode, { id: string; label: string }[]> = {
  resume: [
    { id: "projects", label: "Projects" },
    { id: "experience", label: "Internships & work" },
    { id: "skills", label: "Skills & tools" },
    { id: "education", label: "Education & coursework" },
    { id: "achievements", label: "Achievements" },
    { id: "leadership", label: "Leadership & activities" },
  ],
  technical: [
    { id: "fundamentals", label: "Fundamentals" },
    { id: "scenarios", label: "Real-world scenarios" },
    { id: "tools", label: "Tools & stack" },
    { id: "design", label: "Problem solving & design" },
  ],
  behavioral: [
    { id: "teamwork", label: "Teamwork" },
    { id: "conflict", label: "Conflict" },
    { id: "leadership", label: "Leadership" },
    { id: "failure", label: "Failure & learning" },
    { id: "pressure", label: "Pressure & deadlines" },
    { id: "ownership", label: "Ownership" },
  ],
  custom: [],
  hr: [],
  bank: [],
};

const SAMPLES: Partial<Record<Mode, string>> = {
  technical:
    "Data Scientist, Payments Risk\nBuild and ship fraud detection models in Python. Strong SQL and experience with Spark. Design A/B tests and explain results to stakeholders. Familiarity with model monitoring and drift detection. Bonus: feature stores, Airflow.",
  behavioral:
    "We value ownership, disagreeing and committing, mentoring others, working through ambiguity, and delivering under tight deadlines. Tell us how you handle conflict on a team.",
};

type Saved = {
  mode: Mode; role: string; persona: Persona; length: string; difficulty: number; focus: string; specialty: string; customPersona: string;
  areas: Partial<Record<Mode, string[]>>;
  company: string;
};

function load(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem("rehearsly.setup") || "{}");
  } catch {
    return {};
  }
}

type Stage = { key: string; label: string; done: boolean };

export function Setup({ health, onStarted }: { health: Health | null; onStarted: (id: string) => void }) {
  const saved = useRef(load()).current;
  const [mode, setMode] = useState<Mode>(saved.mode ?? "resume");
  const [file, setFile] = useState<File | null>(null);
  const [role, setRole] = useState(saved.role ?? "");
  const [jd, setJd] = useState("");
  const [persona, setPersona] = useState<Persona>(saved.persona ?? "professional");
  const [length, setLength] = useState(
    ({ quick: "short", standard: "medium", deep: "long" } as Record<string, string>)[saved.length ?? ""] ?? saved.length ?? "medium",
  );
  const [areas, setAreas] = useState<Partial<Record<Mode, string[]>>>(saved.areas ?? {});
  const [difficulty, setDifficulty] = useState(saved.difficulty ?? 2);
  const [focus, setFocus] = useState(saved.focus ?? "");
  const [specialty, setSpecialty] = useState(saved.specialty ?? "");
  const [customPersona, setCustomPersona] = useState(saved.customPersona ?? "");
  const [model, setModel] = useState("");
  const [company, setCompany] = useState(saved.company ?? "");
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<Stage[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [gaps, setGaps] = useState<Gaps | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [ready, setReady] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.history().then(setHistory).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (health?.ok && !model) setModel(health.model);
  }, [health, model]);

  const needsJd = mode === "technical" || mode === "behavioral";
  const materialOk =
    mode === "resume" ? !!file : needsJd ? jd.trim().split(/\s+/).length >= 4 : mode === "hr" ? company.trim().length > 1 : specialty.trim().length > 1;

  function pick(list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    if (!/\.(pdf|docx|txt|md)$/i.test(chosen.name)) {
      setError("Upload a PDF, DOCX or TXT file.");
      return;
    }
    if (chosen.size > 8 * 1024 * 1024) {
      setError("That file is larger than 8 MB.");
      return;
    }
    setError("");
    setFile(chosen);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDrag(false);
    pick(event.dataTransfer.files);
  }

  async function start() {
    if (!materialOk) {
      setError(
        mode === "resume"
          ? "Add your resume to start."
          : needsJd
            ? "Paste a job description, or at least a few skills or values."
            : mode === "hr"
              ? "Enter the company you're interviewing with."
              : "Name the subject you want to practise.",
      );
      return;
    }
    try {
      localStorage.setItem("rehearsly.setup", JSON.stringify({ mode, role, persona, length, difficulty, focus, specialty, customPersona, areas, company }));
    } catch {
      /* storage unavailable */
    }
    const form = new FormData();
    Object.entries({ mode, role, jd, persona, length, difficulty: String(difficulty), focus, specialty, customPersona, model, company, areas: (areas[mode] ?? []).join(",") }).forEach(([k, v]) => form.set(k, v));
    if (mode === "resume" && file) form.set("resume", file);
    setBusy(true);
    setError("");
    setStages([]);
    setProfile(null);
    setGaps(null);
    setBrief(null);
    setTopics([]);
    setReady(null);
    abort.current = new AbortController();
    try {
      await api.create(
        form,
        (event) => {
          if (event.type === "stage") {
            setStages((list) => [...list.map((s) => ({ ...s, done: true })), { key: event.key, label: event.label, done: !event.pending }]);
          } else if (event.type === "profile") setProfile(event.profile);
          else if (event.type === "gaps") setGaps(event.gaps);
          else if (event.type === "brief") setBrief(event.brief);
          else if (event.type === "plan") {
            setStages((list) => list.map((s) => ({ ...s, done: true })));
            setTopics(event.topics);
          } else if (event.type === "session") setReady(event.session.id);
        },
        abort.current.signal,
      );
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
      setBusy(false);
    }
  }

  function cancel() {
    abort.current?.abort();
    setBusy(false);
  }

  const best = history?.stats.best;
  const chosen = areas[mode] ?? [];
  const toggleArea = (id: string) =>
    setAreas((all) => {
      const list = all[mode] ?? [];
      return { ...all, [mode]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] };
    });
  const lengthIndex = Math.max(0, LENGTHS.findIndex((item) => item.id === length));

  return (
    <div className="setup">
      <aside className="summary" aria-label="Your rehearsal">
        <Reveal text="Set up your rehearsal." />
        <p className="lede">Four quick choices. You can change any of them next time.</p>
        <div className="summary-card">
          <div className="summary-light">
            <GhostLight size={70} state={busy ? "thinking" : "idle"} />
          </div>
          <dl>
            {[
              ["Interview", MODES.find((m) => m.id === mode)?.title ?? ""],
              ["Material", mode === "resume" ? file?.name ?? "No resume yet" : mode === "custom" ? specialty || "No subject yet" : mode === "hr" ? "Live company research" : jd.trim() ? `${jd.trim().split(/\s+/).length} words pasted` : "Nothing pasted yet"],
              ["Company", company.trim() || (mode === "hr" ? "Not set yet" : "Any")],
              ["Length", `${LENGTHS[lengthIndex].label}, ${LENGTHS[lengthIndex].count} questions`],
              ["Focus", chosen.length ? AREAS[mode].filter((a) => chosen.includes(a.id)).map((a) => a.label).join(", ") : "Everything"],
              ["Interviewer", PERSONAS.find((p) => p.id === persona)?.title ?? ""],
              ["Starts at", DIFFICULTY_LABEL[difficulty]],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd key={value} className="summary-value">{value}</dd>
              </div>
            ))}
          </dl>
          {history && history.stats.count > 0 && (
            <a className="summary-history" href="#/progress">
              {history.stats.count} rehearsal{history.stats.count === 1 ? "" : "s"} so far{best != null ? `, best ${best}` : ""}
            </a>
          )}
        </div>
      </aside>

      <section className="setup-panel" aria-label="Set up an interview">
        <ol className="setup-steps">
          <li>
            <h2><span className="step-n">1</span>What are you preparing for?</h2>
            <div className="modes" role="radiogroup" aria-label="Interview type">
              {MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === item.id}
                  className={`cue tape-${item.tape} ${mode === item.id ? "on" : ""}`}
                  onClick={() => { setMode(item.id); setError(""); }}
                >
                  <span className="cue-tape" />
                  <strong>{item.title}</strong>
                  <span>{item.line}</span>
                </button>
              ))}
            </div>
          </li>

          <li>
            <h2><span className="step-n">2</span>{mode === "resume" ? "Your resume" : mode === "custom" ? "The subject" : mode === "hr" ? "The company" : "The brief"}</h2>
            {mode === "hr" && (
              <>
                <label className="field">
                  <span>Company</span>
                  <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Google, Deloitte, Zomato, Infosys…" maxLength={80} />
                </label>
                <label className="field">
                  <span>Role <em>optional</em></span>
                  <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Data Scientist, Graduate Engineer Trainee…" maxLength={80} />
                </label>
                <p className="field-note">
                  <I.Target size={14} /> {health?.search === false ? "Live web search is off on this server, so it will use the model's own knowledge of the company." : "Rehearsly searches the web for the company's values, culture, recent news and the HR questions candidates report."}
                </p>
              </>
            )}
            {mode === "resume" && (
              <>
                <div
                  className={`drop ${drag ? "drag" : ""} ${file ? "has" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={onDrop}
                  onClick={() => fileInput.current?.click()}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
                  role="button"
                  tabIndex={0}
                  aria-label={file ? `Selected ${file.name}. Choose a different file` : "Choose your resume file"}
                >
                  {file ? (
                    <>
                      <FileIcon size={22} />
                      <span className="drop-name">{file.name}</span>
                      <span className="drop-size">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                      <button type="button" className="icon-btn" aria-label="Remove file" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                        <Close size={16} />
                      </button>
                    </>
                  ) : (
                    <>
                      <Upload size={22} />
                      <span><strong>Drop your resume here</strong> or click to choose a file</span>
                      <span className="drop-size">PDF, DOCX or TXT, up to 8 MB</span>
                    </>
                  )}
                  <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" hidden onChange={(e) => pick(e.target.files)} />
                </div>
                <label className="field">
                  <span>Role you're aiming for</span>
                  <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Data Scientist, SDE, Product Analyst…" maxLength={80} />
                </label>
                <label className="field">
                  <span>Job description <em>optional, finds the skills your resume is missing</em></span>
                  <textarea value={jd} onChange={(e) => setJd(e.target.value)} rows={3} placeholder="Paste the posting to get a skill-gap map and a question on your weakest area." />
                </label>
              </>
            )}
            {needsJd && (
              <>
                <label className="field">
                  <span>{mode === "behavioral" ? "Values, qualities or the posting" : "Job description"}</span>
                  <textarea value={jd} onChange={(e) => setJd(e.target.value)} rows={7} placeholder={mode === "behavioral" ? "Ownership, conflict resolution, mentoring, handling ambiguity…" : "Paste the full posting, or just the key skills."} />
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Role title <em>optional</em></span>
                    <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Backend Engineer" maxLength={80} />
                  </label>
                  <button type="button" className="link" onClick={() => setJd(SAMPLES[mode] ?? "")}>Use a sample</button>
                </div>
              </>
            )}
            {mode === "custom" && (
              <>
                <label className="field">
                  <span>Subject</span>
                  <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="System design, SQL, product sense, case interview…" maxLength={120} />
                </label>
                <label className="field">
                  <span>Interviewer <em>optional, overrides the presets below</em></span>
                  <input value={customPersona} onChange={(e) => setCustomPersona(e.target.value)} placeholder="a staff engineer at a fintech startup" maxLength={200} />
                </label>
              </>
            )}
            {mode !== "hr" && mode !== "custom" && (
              <label className="field">
                <span>Company <em>optional, tailors the questions and unlocks its past questions afterwards</em></span>
                <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Where are you interviewing?" maxLength={80} />
              </label>
            )}
            {mode !== "behavioral" && mode !== "hr" && (
              <label className="field">
                <span>Anything specific? <em>optional</em></span>
                <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="SQL window functions, ML deployment, leadership…" maxLength={200} />
              </label>
            )}
          </li>

          <li>
            <h2><span className="step-n">3</span>How long, and what to cover</h2>
            <div className="lengths" role="radiogroup" aria-label="Interview length" style={{ ["--pick" as string]: lengthIndex }}>
              <span className="lengths-glider" aria-hidden="true" />
              {LENGTHS.map((item) => (
                <button key={item.id} type="button" role="radio" aria-checked={length === item.id} className={`length ${length === item.id ? "on" : ""}`} onClick={() => setLength(item.id)}>
                  <span className="length-bars" aria-hidden="true">
                    {Array.from({ length: 8 }, (_, i) => <i key={i} className={i < item.count ? "lit" : ""} style={{ transitionDelay: `${i * 25}ms` }} />)}
                  </span>
                  <strong>{item.label}</strong>
                  <span>{item.count} questions</span>
                  <small><Clock size={12} /> {item.time}</small>
                </button>
              ))}
            </div>
            {AREAS[mode].length > 0 && (
              <div className="areas">
                <p className="areas-label">
                  {mode === "resume" ? "Only ask about" : "Concentrate on"}
                  <span>{chosen.length ? `${chosen.length} selected` : "Everything. Pick any to narrow it down"}</span>
                </p>
                <div className="area-chips">
                  {AREAS[mode].map((item) => {
                    const on = chosen.includes(item.id);
                    return (
                      <button key={item.id} type="button" className={`area ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggleArea(item.id)}>
                        <span className="area-tick" aria-hidden="true"><Check size={12} /></span>
                        {item.label}
                      </button>
                    );
                  })}
                  {chosen.length > 0 && (
                    <button type="button" className="link area-clear" onClick={() => setAreas((all) => ({ ...all, [mode]: [] }))}>Clear</button>
                  )}
                </div>
              </div>
            )}
          </li>

          <li>
            <h2><span className="step-n">4</span>Your interviewer</h2>
            <div className="personas" role="radiogroup" aria-label="Interviewer style">
              {PERSONAS.map((item) => (
                <button key={item.id} type="button" role="radio" aria-checked={persona === item.id} className={`persona ${persona === item.id ? "on" : ""}`} onClick={() => setPersona(item.id)}>
                  <strong>{item.title}</strong>
                  <span>{item.line}</span>
                </button>
              ))}
            </div>
            <div className="knobs">
              <div className="knob">
                <span className="knob-label">Start at <strong>{DIFFICULTY_LABEL[difficulty]}</strong></span>
                <div className="ladder" role="radiogroup" aria-label="Starting difficulty">
                  {[1, 2, 3, 4, 5].map((level) => (
                    <button key={level} type="button" role="radio" aria-checked={difficulty === level} aria-label={DIFFICULTY_LABEL[level]} title={DIFFICULTY_LABEL[level]} className={level <= difficulty ? "on" : ""} style={{ height: `${10 + level * 5}px` }} onClick={() => setDifficulty(level)} />
                  ))}
                </div>
              </div>
              {health && health.models.length > 1 && (
                <label className="knob">
                  <span className="knob-label">Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {health.models.map((name) => <option key={name} value={name}>{name.replace(":latest", "")}</option>)}
                  </select>
                </label>
              )}
            </div>
          </li>
        </ol>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="primary big" onClick={start} disabled={busy}>
          Start rehearsal
        </button>
      </section>

      {busy && (
        <div className="prep" role="dialog" aria-modal="true" aria-labelledby="prep-title">
          <div className="prep-card">
            <div className="prep-head">
              <GhostLight size={84} state={ready ? "idle" : "thinking"} />
              <div>
                <h2 id="prep-title">{ready ? "Your running order" : "Setting the stage"}</h2>
                <p>{ready ? "This is what the interviewer will cover. It adapts as you answer." : "The first run can take a moment while the model loads."}</p>
              </div>
            </div>
            <ul className="prep-stages" aria-live="polite">
              {stages.map((stage) => (
                <li key={stage.key} className={stage.done ? "done" : ""}>
                  <span className="prep-mark">{stage.done ? <Check size={14} /> : <span className="spinner" />}</span>
                  {stage.label}
                </li>
              ))}
            </ul>
            {profile && (profile.skills.length > 0 || profile.projects.length > 0) && (
              <div className="prep-block">
                <h3>What it found{profile.name ? ` for ${profile.name}` : ""}</h3>
                <div className="chips">
                  {profile.projects.slice(0, 3).map((item) => <span key={item} className="chip chip-blue" title={item}>{item.split(/[:–-]/)[0].slice(0, 40)}</span>)}
                  {profile.skills.slice(0, 9).map((item) => <span key={item} className="chip">{item}</span>)}
                </div>
              </div>
            )}
            {brief && (
              <div className="prep-block">
                <h3>What it learned about {brief.company}{brief.live ? `, from ${brief.sources.length} sources` : ""}</h3>
                {brief.overview && <p className="muted small">{brief.overview}</p>}
                <div className="chips">
                  {brief.values.slice(0, 5).map((v) => <span key={v} className="chip chip-blue">{v.split(/[:–-]/)[0].slice(0, 40)}</span>)}
                  {brief.news.slice(0, 2).map((n) => <span key={n} className="chip chip-mint" title={n}>{n.slice(0, 48)}{n.length > 48 ? "…" : ""}</span>)}
                </div>
              </div>
            )}
            {gaps && gaps.match != null && (
              <div className="prep-block">
                <h3>Resume vs job description: {gaps.match}% match</h3>
                <div className="chips">
                  {gaps.matched.map((item) => <span key={item} className="chip chip-mint"><Check size={12} />{item}</span>)}
                  {gaps.missing.map((item) => <span key={item} className="chip chip-pink">Missing: {item}</span>)}
                </div>
              </div>
            )}
            {topics.length > 0 && (
              <ol className="order">
                {topics.map((topic, index) => (
                  <li key={topic.id} style={{ animationDelay: `${index * 70}ms` }}>
                    <span className="order-n">{index + 1}</span>
                    <div>
                      <strong>{topic.title}</strong>
                      <span className="order-kind">{KIND_LABEL[topic.kind] ?? topic.kind}</span>
                      {topic.evidence && <span className="order-evidence">“{topic.evidence}”</span>}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <div className="prep-actions">
              <button type="button" className="ghost-btn" onClick={cancel}>{ready ? "Back to setup" : "Cancel"}</button>
              <button type="button" className="primary" disabled={!ready} onClick={() => {
                  unlockAudio();
                  if (ready) onStarted(ready);
                }} autoFocus>
                {ready ? "Begin interview" : "Preparing…"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

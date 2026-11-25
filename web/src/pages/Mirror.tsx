import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Health, type MirrorFlaw, type MirrorSession, type MirrorTurn } from "../lib/api";
import { canSpeak, setServerVoice, speakNatural, startRecording, stopAll, unlockAudio, type Recording, type VoiceChoice } from "../lib/voice";
import { go } from "../lib/router";
import { when } from "../lib/format";
import { Face, variantForVoice } from "../components/Face";
import { CountUp } from "../components/Motion";
import * as I from "../components/Icons";

const KEY = "rehearsly.mirror.v1";
const TAGS: { key: MirrorFlaw; label: string; hint: string }[] = [
  { key: "bluff", label: "Bluffing", hint: "Overstated their role, or said something that isn't right" },
  { key: "ramble", label: "Rambling", hint: "Long and wandering, half an answer" },
  { key: "vague", label: "Vague", hint: "No specifics, no numbers, no 'I'" },
  { key: "dodge", label: "Dodged", hint: "Answered a different, easier question" },
  { key: "contradiction", label: "Contradicted", hint: "Didn't match something said earlier" },
];

function loadAll(): MirrorSession[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function saveOne(session: MirrorSession) {
  try {
    const rest = loadAll().filter((s) => s.id !== session.id);
    localStorage.setItem(KEY, JSON.stringify([session, ...rest].slice(0, 20)));
  } catch {
    /* storage full or unavailable */
  }
}

export function Mirror({ id, health }: { id?: string; health: Health | null }) {
  return id ? <MirrorRoom id={id} health={health} /> : <MirrorStart />;
}

function MirrorStart() {
  const [path, setPath] = useState<"candidate" | "self">(() => {
    try {
      return (localStorage.getItem("rehearsly.mirror.path") as "candidate" | "self") || "candidate";
    } catch {
      return "candidate";
    }
  });
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("rehearsly.mirror.name") || "";
    } catch {
      return "";
    }
  });
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [selfVoice, setSelfVoice] = useState<VoiceChoice>("hannah");
  const [role, setRole] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("rehearsly.setup") || "{}").role || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const past = loadAll();

  function choose(next: "candidate" | "self") {
    setPath(next);
    setError("");
    try {
      localStorage.setItem("rehearsly.mirror.path", next);
    } catch {
      /* ignore */
    }
  }

  async function begin() {
    setBusy(true);
    setError("");
    try {
      let started;
      if (path === "self") {
        const form = new FormData();
        form.set("name", name.trim());
        form.set("role", role.trim());
        form.set("voice", selfVoice);
        if (file) form.set("resume", file);
        else form.set("resumeText", pasted);
        try {
          localStorage.setItem("rehearsly.mirror.name", name.trim());
        } catch {
          /* ignore */
        }
        started = await api.mirrorSelf(form);
      } else {
        started = await api.mirrorStart(role.trim());
      }
      const session: MirrorSession = {
        id: Math.random().toString(36).slice(2, 12),
        kind: path,
        role: started.role,
        createdAt: Date.now() / 1000,
        candidate: started.candidate,
        suggested: started.suggested,
        sealed: started.sealed,
        turns: [],
        reveal: null,
      };
      saveOne(session);
      go(`/mirror/${session.id}`);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mirror-start">
      <div className="mirror-hero">
        <div className="mirror-faces" aria-hidden="true">
          <Face size={120} state={busy ? "thinking" : "idle"} mood="curious" variant="f" label="You, the interviewer" />
          <span className="mirror-divider" />
          <Face size={120} state="idle" mood="neutral" variant="m" className="cast-candidate" label="The candidate" />
        </div>
        <h1>You're the interviewer now.</h1>
        <div className="mirror-paths" role="tablist" aria-label="Who are you interviewing?">
          <button type="button" role="tab" aria-selected={path === "candidate"} className={path === "candidate" ? "on" : ""} onClick={() => choose("candidate")}>
            <strong>Interview a candidate</strong>
            <span>Ambar or Aanya walks in with a secret. Spot the weak answers.</span>
          </button>
          <button type="button" role="tab" aria-selected={path === "self"} className={path === "self" ? "on" : ""} onClick={() => choose("self")}>
            <strong>Interview yourself</strong>
            <span>An AI you, built from your resume, answers your questions the way a well-prepared you would.</span>
          </button>
        </div>
        {path === "candidate" ? (
          <>
            <p className="lede">Maybe they're genuinely good. Maybe they're bluffing, rambling, or dodging. Ask your questions, mark each answer solid or weak, and find out at the end how much you caught.</p>
            <div className="mirror-form">
              <label className="field">
                <span>Role they're applying for</span>
                <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Data analyst, Backend engineer" onKeyDown={(e) => e.key === "Enter" && !busy && begin()} />
              </label>
              <button type="button" className="primary" onClick={begin} disabled={busy}>
                <I.Mirror size={17} />{busy ? "Briefing the candidate…" : "Bring in a candidate"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="lede">See what a strong interviewer would ask you, and hear how your own experience sounds told well. Then answer the same questions yourself.</p>
            <div className="mirror-self">
              <div className="field-row">
                <label className="field">
                  <span>Your name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Siddarth" autoComplete="given-name" />
                </label>
                <label className="field">
                  <span>Role you're preparing for</span>
                  <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Data scientist" />
                </label>
              </div>
              <div className="field">
                <span>Your resume</span>
                <label className={`mirror-drop ${file ? "has" : ""}`}>
                  <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  <I.Upload size={18} />
                  {file ? <><strong>{file.name}</strong><button type="button" className="link" onClick={(e) => { e.preventDefault(); setFile(null); }}>Remove</button></> : <span>Upload a PDF, DOCX or TXT</span>}
                </label>
                {!file && <textarea rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="…or paste your resume text here" aria-label="Resume text" />}
              </div>
              <div className="field">
                <span>Voice for your AI self</span>
                <div className="voice-choices" role="radiogroup">
                  {([["hannah", "Female, Hannah"], ["troy", "Male, Troy"], ["austin", "Male, Austin"]] as [VoiceChoice, string][]).map(([v, label]) => (
                    <button key={v} type="button" role="radio" aria-checked={selfVoice === v} className={`chip-btn ${selfVoice === v ? "picked" : ""}`} onClick={() => setSelfVoice(v)}>{label}</button>
                  ))}
                </div>
              </div>
              <button type="button" className="primary" onClick={begin} disabled={busy || name.trim().length < 2 || (!file && pasted.trim().split(/\s+/).length < 25)}>
                <I.Mirror size={17} />{busy ? "Reading your resume…" : `Meet AI ${name.trim().split(" ")[0] || "you"}`}
              </button>
            </div>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {past.length > 0 && (
        <section className="panel mirror-past">
          <h2>Your past panels</h2>
          <ul>
            {past.map((s) => (
              <li key={s.id}>
                <a href={`#/mirror/${s.id}`}>
                  <strong>{s.candidate.name}</strong>
                  <span>{s.role}, {when(s.createdAt)}</span>
                  <em>{s.kind === "self" ? `Self-interview, ${s.turns.length} question${s.turns.length === 1 ? "" : "s"}` : s.reveal ? `${s.reveal.persona.label}, ${s.reveal.stats.overall}/100` : `${s.turns.length} questions, not revealed`}</em>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MirrorRoom({ id, health }: { id: string; health: Health | null }) {
  const [session, setSession] = useState<MirrorSession | null>(() => loadAll().find((s) => s.id === id) ?? null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [level, setLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [revealing, setRevealing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const natural = health?.tts === "groq";
  useEffect(() => setServerVoice(natural), [natural]);
  useEffect(() => () => { stopAll(); recording?.cancel(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [session?.turns.length, streaming]);

  const update = useCallback((next: MirrorSession) => {
    setSession(next);
    saveOne(next);
  }, []);

  if (!session) {
    return (
      <div className="empty">
        <h1>That panel isn't here.</h1>
        <p>Mirror sessions are kept in this browser only.</p>
        <a className="primary" href="#/mirror">Bring in a new candidate</a>
      </div>
    );
  }
  if (session.reveal) return <MirrorReveal session={session} />;

  const candidate = session.candidate;
  const self = session.kind === "self";
  const first = candidate.name.split(" ")[0];
  const asked = new Set(session.turns.map((t) => t.question));
  const suggestions = session.suggested.filter((q) => !asked.has(q)).slice(0, 3);
  const unjudged = session.turns.filter((t) => !t.verdict).length;

  async function ask(text: string) {
    const question = text.trim();
    if (!question || busy || !session) return;
    setBusy(true);
    setError("");
    setDraft("");
    setPending(question);
    setStreaming(" ");
    stopAll();
    unlockAudio();
    try {
      const done = await api.mirrorAnswer(session.sealed, question, session.turns, (token) => setStreaming((s) => s + token));
      const turn: MirrorTurn = { id: Math.random().toString(36).slice(2, 10), question, answer: done.answer, sealedTurn: done.sealedTurn, verdict: null, tag: null, notes: done.notes };
      const next = { ...session, turns: [...session.turns, turn] };
      update(next);
      setStreaming("");
      setBusy(false); // you can type the next question while the answer is being read out
      if (voiceOn && (natural || canSpeak())) {
        setSpeaking(true);
        await speakNatural(done.answer, { voice: (natural ? candidate.voice : "device") as VoiceChoice, style: "professional", onLevel: setLevel });
        setSpeaking(false);
        setLevel(0);
      }
    } catch (reason) {
      setError((reason as Error).message);
      setStreaming("");
      setDraft(question);
    } finally {
      setBusy(false);
    }
  }

  function judge(turnId: string, verdict: "solid" | "weak") {
    if (!session) return;
    update({ ...session, turns: session.turns.map((t) => (t.id === turnId ? { ...t, verdict: t.verdict === verdict ? null : verdict, tag: verdict === "solid" ? null : t.tag } : t)) });
  }
  function tag(turnId: string, flaw: MirrorFlaw) {
    if (!session) return;
    update({ ...session, turns: session.turns.map((t) => (t.id === turnId ? { ...t, tag: t.tag === flaw ? null : flaw, verdict: "weak" } : t)) });
  }

  async function reveal() {
    if (!session) return;
    setRevealing(true);
    setError("");
    stopAll();
    try {
      const result = await api.mirrorReveal(session.sealed, session.turns);
      update({ ...session, reveal: result });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRevealing(false);
    }
  }

  async function practise() {
    if (!session) return;
    setRevealing(true);
    setError("");
    stopAll();
    const form = new FormData();
    form.set("mode", "bank");
    form.set("origin", "mirror");
    form.set("role", session.role);
    form.set("length", "medium");
    form.set("persona", "professional");
    form.set("questions", JSON.stringify(session.turns.filter((t) => t.question.split(" ").length > 2).map((t) => ({ question: t.question, subject: "" }))));
    try {
      let id = "";
      await api.create(form, (event) => {
        if (event.type === "session") id = event.session.id;
      });
      if (id) go(`/room/${id}`);
    } catch (reason) {
      setError((reason as Error).message);
      setRevealing(false);
    }
  }

  async function mic() {
    if (recording) {
      const rec = recording;
      setRecording(null);
      const { blob, spoke, duration } = await rec.stop();
      if (!spoke && duration < 1.2) return;
      try {
        const { text } = await api.transcribe(blob);
        if (text.trim()) setDraft((d) => (d ? `${d} ${text}` : text));
      } catch (reason) {
        setError((reason as Error).message);
      }
      return;
    }
    stopAll();
    try {
      setRecording(await startRecording({}));
    } catch (reason) {
      setError((reason as Error).name === "NotAllowedError" ? "Microphone access was blocked." : (reason as Error).message);
    }
  }

  const faceState = speaking ? "speaking" : busy ? "thinking" : recording || draft ? "listening" : "idle";

  return (
    <div className="mirror-room">
      <aside className="mirror-candidate">
        <Face size={132} state={faceState} level={level} mood={busy ? "curious" : self ? "pleased" : "neutral"} label={candidate.name} variant={variantForVoice(candidate.voice)} className={self ? "" : "cast-candidate"} />
        <h1>{self ? `AI ${candidate.name}` : candidate.name}</h1>
        <p className="muted">{candidate.headline}</p>
        <p className="mirror-for">{self ? "Preparing for" : "Applying for"} {session.role}</p>
        <h2>{self ? "From your resume" : "Their resume"}</h2>
        <ul className="mirror-resume">{candidate.resume.map((line) => <li key={line}>{line}</li>)}</ul>
        <p className="muted small">
          {self
            ? "This is a well-prepared version of you, answering only from your resume. Ask what an interviewer would, and borrow what works. Never say anything in a real interview that isn't true for you."
            : "Something about this candidate may not be what it seems. Ask about the resume, follow up on anything that sounds too good, and judge each answer."}
        </p>
      </aside>

      <section className="mirror-stage">
        <div className="mirror-bar">
          <span className="muted small">{session.turns.length} question{session.turns.length === 1 ? "" : "s"} asked{!self && unjudged ? `, ${unjudged} not judged yet` : ""}</span>
          <div className="toggles">
            {(natural || canSpeak()) && (
              <button type="button" className={`toggle ${voiceOn ? "on" : ""}`} onClick={() => { setVoiceOn((v) => !v); stopAll(); setSpeaking(false); }} aria-pressed={voiceOn}>
                {voiceOn ? <I.Speaker size={15} /> : <I.SpeakerOff size={15} />}<span>Voice</span>
              </button>
            )}
            {self ? (
              <button type="button" className="primary" onClick={practise} disabled={revealing || session.turns.length < 1 || busy} title="Start a rehearsal where you answer these questions yourself">
                <I.Target size={15} />{revealing ? "Setting it up…" : "Now I'll answer these"}
              </button>
            ) : (
              <button type="button" className="primary" onClick={reveal} disabled={revealing || session.turns.length < 2 || busy}>
                <I.Flag size={15} />{revealing ? "Revealing…" : "End and reveal"}
              </button>
            )}
          </div>
        </div>

        <div className="mirror-script" ref={scroller}>
          {session.turns.length === 0 && !streaming && (
            <div className="mirror-empty">
              <p>{self ? `AI ${first} is ready. Ask the questions you dread most, or pick one below.` : `${first} is seated and waiting. Open with anything you like.`}</p>
            </div>
          )}
          {session.turns.map((turn, index) => (
            <div key={turn.id} className="mirror-turn">
              <div className="line line-you mirror-q"><span className="cue-name">You, the interviewer</span><p>{turn.question}</p></div>
              <div className="line line-them mirror-a">
                <span className="cue-name">
                  <span>{self ? `AI ${first}` : first}</span>
                  {(natural || canSpeak()) && (
                    <button type="button" className="replay" onClick={() => { setSpeaking(true); void speakNatural(turn.answer, { voice: (natural ? candidate.voice : "device") as VoiceChoice, style: "professional", onLevel: setLevel }).then(() => { setSpeaking(false); setLevel(0); }); }} aria-label="Hear this again"><I.Speaker size={14} /></button>
                  )}
                </span>
                <p>{turn.answer}</p>
                {self && turn.notes && (turn.notes.structure || turn.notes.moves.length > 0) && (
                  <div className="why-works">
                    <strong>Why this works</strong>
                    {turn.notes.structure && <p className="why-shape">{turn.notes.structure}</p>}
                    <ul>{turn.notes.moves.map((m) => <li key={m}><I.Check size={13} />{m}</li>)}</ul>
                  </div>
                )}
                {!self && <div className="judge" role="group" aria-label={`Judge answer ${index + 1}`}>
                  <button type="button" className={`judge-btn solid ${turn.verdict === "solid" ? "on" : ""}`} onClick={() => judge(turn.id, "solid")} aria-pressed={turn.verdict === "solid"}>
                    <I.Check size={14} />Solid
                  </button>
                  <button type="button" className={`judge-btn weak ${turn.verdict === "weak" ? "on" : ""}`} onClick={() => judge(turn.id, "weak")} aria-pressed={turn.verdict === "weak"}>
                    <I.Half size={14} />Weak
                  </button>
                  <AnimatePresence>
                    {turn.verdict === "weak" && (
                      <motion.div className="judge-tags" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
                        {TAGS.map((t) => (
                          <button key={t.key} type="button" className={`chip-btn ${turn.tag === t.key ? "on" : ""}`} onClick={() => tag(turn.id, t.key)} title={t.hint} aria-pressed={turn.tag === t.key}>{t.label}</button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="mirror-turn">
              <div className="line line-you mirror-q"><span className="cue-name">You, the interviewer</span><p>{pending}</p></div>
              <div className="line line-them mirror-a">
                <span className="cue-name">{self ? `AI ${first}` : first}</span>
                <p>{streaming.trim() || <span className="typing"><i /><i /><i /></span>}<span className="caret" /></p>
              </div>
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {suggestions.length > 0 && !busy && (
            <div className="mirror-suggest">
              <span className="muted small">Need an idea?</span>
              {suggestions.map((q) => <button key={q} type="button" className="chip-btn" onClick={() => setDraft(q)}>{q}</button>)}
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void ask(draft); } }}
              placeholder={recording ? "Listening… press the mic again when you're done" : "Ask your question…"}
              rows={2}
              aria-label="Your question"
              disabled={busy}
            />
            <div className="composer-bar">
              <span className="composer-count muted small">Ctrl / ⌘ + Enter to ask</span>
              <div className="composer-actions">
                <button type="button" className={`mic ${recording ? "mic-on" : ""}`} onClick={mic} disabled={busy} aria-label={recording ? "Stop recording" : "Ask by voice"}>
                  {recording ? <I.StopIcon size={18} /> : <I.Mic size={20} />}
                </button>
                <button type="button" className="primary send" onClick={() => ask(draft)} disabled={busy || !draft.trim()}><I.Send size={16} />Ask</button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function MirrorReveal({ session }: { session: MirrorSession }) {
  const r = session.reveal!;
  const tone = r.stats.overall >= 70 ? "good" : r.stats.overall >= 45 ? "mid" : "low";
  return (
    <article className="mirror-reveal">
      <header className="reveal-head">
        <div className="reveal-face">
          <Face size={150} state="idle" mood={r.persona.key === "strong" ? "pleased" : "doubtful"} label={session.candidate.name} variant={variantForVoice(session.candidate.voice)} className="cast-candidate" />
        </div>
        <div>
          <p className="muted">{session.candidate.name} was</p>
          <motion.h1 initial={{ opacity: 0, y: 12, filter: "blur(6px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 0.6, delay: 0.2 }}>
            {r.persona.label}
          </motion.h1>
          <p className="lede">{r.persona.about}</p>
          {r.truth.length > 0 && <p className="muted small">Behind the resume: {r.truth.join(" ")}</p>}
        </div>
        <div className={`reveal-score tone-${tone}`}>
          <CountUp value={r.stats.overall} className="score-numeral" delay={500} />
          <span className="score-out">your interviewer score</span>
        </div>
      </header>

      <section className="review-grid">
        <div className="panel">
          <h2>What you caught</h2>
          <dl className="stats stats-big">
            <div><dt>Weak answers caught</dt><dd>{r.stats.caught}<small> of {r.stats.flawed}</small></dd></div>
            <div><dt>False alarms</dt><dd>{r.stats.falseAlarms}</dd></div>
            <div><dt>Judged correctly</dt><dd>{r.stats.accuracy}<small>%</small></dd></div>
            <div><dt>Your questions</dt><dd>{r.questioning}<small>/10</small></dd></div>
          </dl>
        </div>
        <div className="panel">
          <h2>How you interviewed</h2>
          {r.strengths.length > 0 && <ul className="points points-good">{r.strengths.map((s) => <li key={s}><I.Check size={16} />{s}</li>)}</ul>}
          {r.improvements.length > 0 && <ul className="points points-gap">{r.improvements.map((s) => <li key={s}><I.Half size={16} />{s}</li>)}</ul>}
          {r.missedFollowup && <p className="mirror-missed"><strong>The follow-up you should have asked:</strong> {r.missedFollowup}</p>}
        </div>
      </section>

      <section className="panel">
        <h2>Answer by answer</h2>
        <ol className="reveal-turns">
          {r.turns.map((t) => (
            <li key={t.turn} className={`reveal-turn ${t.correct === true ? "right" : t.correct === false ? "wrong" : "unjudged"}`}>
              <div className="reveal-badges">
                <span className={`truth truth-${t.truth}`}>{t.flawLabel}</span>
                <span className="your-call">
                  {t.verdict ? <>You said {t.verdict}{t.correct ? <I.Check size={14} /> : <I.Close size={14} />}</> : "Not judged"}
                  {t.tagRight && <em>and named it</em>}
                </span>
              </div>
              <p className="reveal-q">{t.question}</p>
              <p className="reveal-a">{t.answer}</p>
              {t.why && <p className="reveal-why"><I.Bulb size={14} /> {t.why}</p>}
            </li>
          ))}
        </ol>
      </section>

      <div className="verdict-actions">
        <a className="primary" href="#/mirror"><I.Mirror size={16} />Interview another candidate</a>
        <a className="ghost-btn" href="#/new">Back to being the candidate</a>
      </div>
    </article>
  );
}

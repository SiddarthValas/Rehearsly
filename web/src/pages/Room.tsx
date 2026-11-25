import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Assessment, type Health, type Message, type Session, type StreamEvent } from "../lib/api";
import {
  canSpeak, previewVoice, setBlockedHandler, setServerVoice, speakNatural, startRecording, stopAll as stopSpeaking, unlockAudio, VOICE_LABEL,
  type Recording, type VoiceChoice,
} from "../lib/voice";
import { AREA_LABEL, clock, DIFFICULTY_LABEL, KIND_LABEL, MODE_LABEL, scoreTone, STATUS_LABEL } from "../lib/format";
import { CountUp } from "../components/Motion";
import { PracticeNext } from "../components/PracticeNext";
import { go } from "../lib/router";
import { GhostLight, type LightState } from "../components/GhostLight";
import { Meter } from "../components/Charts";
import * as I from "../components/Icons";

function pref(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(`rehearsly.${key}`);
    return value == null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}
function setPref(key: string, value: boolean) {
  try {
    localStorage.setItem(`rehearsly.${key}`, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const StatusIcon = ({ status }: { status: string }) =>
  status === "covered" ? <I.Check size={14} /> : status === "thin" ? <I.Half size={14} /> : status === "skipped" ? <I.Dash size={14} /> : <I.Circle size={14} />;

export function Room({ id, health }: { id: string; health: Health | null }) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [light, setLight] = useState<LightState>("idle");
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const natural = health?.tts === "groq";
  const [voiceOut, setVoiceOut] = useState(() => pref("voiceOut", true));
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>(() => {
    try {
      return (localStorage.getItem("rehearsly.voiceChoice") as VoiceChoice) || "hannah";
    } catch {
      return "hannah";
    }
  });
  const [speakLevel, setSpeakLevel] = useState(0);
  const effectiveVoice: VoiceChoice = natural ? voiceChoice : "device";
  const voiceRef = useRef(effectiveVoice);
  voiceRef.current = effectiveVoice;
  useEffect(() => setServerVoice(natural), [natural]);
  const [blockedRetry, setBlockedRetry] = useState<(() => void) | null>(null);
  useEffect(() => {
    // Any click or key press in the room keeps audio unlocked for browsers with strict autoplay rules.
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    setBlockedHandler((retry) => setBlockedRetry(() => retry));
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      setBlockedHandler(null);
    };
  }, []);
  const [handsFree, setHandsFree] = useState(() => pref("handsFree", false));
  const [blind, setBlind] = useState(() => pref("blind", false));
  const [hint, setHint] = useState<{ hint: string; structure: string[] } | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const [answerStart, setAnswerStart] = useState(Date.now());
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [wrapUp, setWrapUp] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const handsFreeRef = useRef(handsFree);
  const sessionRef = useRef<Session | null>(null);
  const recordingRef = useRef<Recording | null>(null);
  const levels = useRef<number[]>(Array(28).fill(0));
  const [, force] = useState(0);
  const voiceOutRef = useRef(voiceOut);
  const sendRef = useRef<(content: string, via?: "text" | "voice", duration?: number) => Promise<void>>(async () => undefined);
  voiceOutRef.current = voiceOut;
  handsFreeRef.current = handsFree;
  sessionRef.current = session;
  recordingRef.current = recording;

  useEffect(() => {
    api.session(id)
      .then((data) => {
        setSession(data);
        setMessages(data.messages);
      })
      .catch((reason: Error) => setError(reason.message));
    return () => {
      stopSpeaking();
      recordingRef.current?.cancel();
    };
  }, [id]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, hint]);

  const lastInterviewer = useMemo(() => [...messages].reverse().find((m) => m.role === "interviewer"), [messages]);
  const lastAssessed = useMemo(() => [...messages].reverse().find((m) => m.role === "candidate" && m.assessment), [messages]);
  const lastAnswer = useMemo(() => [...messages].reverse().find((m) => m.role === "candidate"), [messages]);
  const complete = session?.complete ?? false;

  /* ------------------------------------------------------------- voice in */

  const beginRecording = useCallback(async (auto = false) => {
    if (recordingRef.current || sessionRef.current?.complete) return;
    setError("");
    stopSpeaking();
    try {
      const rec = await startRecording({
        onLevel: (value) => {
          setLevel(value);
          levels.current = [...levels.current.slice(1), value];
          force((n) => (n + 1) % 1000);
        },
        autoStopAfterSilence: auto || handsFreeRef.current ? 1900 : undefined,
        onAutoStop: () => void finishRecording(true),
      });
      setRecording(rec);
      recordingRef.current = rec;
      setLight("listening");
      setAnswerStart(Date.now());
    } catch (reason) {
      setError((reason as Error).name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser's site settings." : (reason as Error).message);
      setHandsFree(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishRecording = useCallback(async (autoSend = false) => {
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    setRecording(null);
    setLevel(0);
    levels.current = Array(28).fill(0);
    setLight("idle");
    const { blob, duration, spoke } = await rec.stop();
    if (!spoke && duration < 1.2) return;
    setTranscribing(true);
    try {
      const { text } = await api.transcribe(blob);
      if (!text.trim()) {
        setError("Didn't catch that. Try again a little closer to the mic.");
        if (handsFreeRef.current) window.setTimeout(() => void beginRecording(true), 600);
        return;
      }
      if (autoSend && handsFreeRef.current) {
        void sendRef.current(text, "voice", duration);
      } else {
        setDraft((current) => (current ? `${current} ${text}` : text));
        input.current?.focus();
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setTranscribing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeInstead = useCallback(() => {
    const rec = recordingRef.current;
    if (rec) {
      recordingRef.current = null;
      rec.cancel();
    }
    setRecording(null);
    setLevel(0);
    levels.current = Array(28).fill(0);
    setLight("idle");
    window.setTimeout(() => input.current?.focus(), 0);
  }, []);

  /* ------------------------------------------------------------- voice out */

  const voice = useCallback(async (text: string, last: boolean) => {
    if (voiceOutRef.current) {
      await speakNatural(text, {
        voice: voiceRef.current,
        style: sessionRef.current?.config.persona,
        onStart: () => setLight("speaking"),
        onLevel: setSpeakLevel,
      });
      setLight("idle");
    }
    if (!last && handsFreeRef.current && !sessionRef.current?.complete) void beginRecording(true);
  }, [beginRecording]);
  /* ------------------------------------------------------------- answering */

  const send = useCallback(async (content: string, via: "text" | "voice" = "text", duration?: number) => {
    const current = sessionRef.current;
    const text = content.trim();
    if (!current || !text || current.complete) return;
    setBusy(true);
    setError("");
    setHint(null);
    setBlockedRetry(null);
    unlockAudio();
    setDraft("");
    setLight("thinking");
    stopSpeaking();
    const elapsed = duration ?? (Date.now() - answerStart) / 1000;
    const tempId = `temp-${Date.now()}`;
    setMessages((list) => [...list, { id: tempId, role: "candidate", content: text, kind: "answer", topic: current.active, difficulty: current.difficulty, ts: Date.now() / 1000, via }]);
    let streamingId = "";
    let finalQuestion: Message | null = null;
    let finalSession: Session | null = null;
    const handle = (event: StreamEvent) => {
      if (event.type === "answer") {
        setMessages((list) => list.map((m) => (m.id === tempId ? event.message : m)));
      } else if (event.type === "assessment") {
        setMessages((list) => list.map((m) => (m.id === event.messageId ? { ...m, assessment: event.assessment } : m)));
      } else if (event.type === "difficulty") {
        setSession((s) => (s ? { ...s, difficulty: event.difficulty } : s));
      } else if (event.type === "start") {
        streamingId = event.message.id;
        setMessages((list) => [...list, { ...event.message, streaming: true }]);
      } else if (event.type === "token") {
        setMessages((list) => list.map((m) => (m.id === streamingId ? { ...m, content: m.content + event.text } : m)));
      } else if (event.type === "question") {
        finalQuestion = event.message;
        setMessages((list) =>
          list.some((m) => m.id === event.message.id) ? list.map((m) => (m.id === event.message.id ? event.message : m)) : [...list, event.message],
        );
      } else if (event.type === "done") {
        finalSession = event.session;
      }
    };
    try {
      // Pace (wpm) only means something for spoken answers; typing time would give nonsense numbers.
      await api.answer(current.id, { content: text, duration: via === "voice" ? Math.round(elapsed * 10) / 10 : null, via }, handle);
      if (finalSession) {
        setSession(finalSession);
        setMessages((finalSession as Session).messages);
        if ((finalSession as Session).complete && !current.complete) window.setTimeout(() => setWrapUp(true), 1400);
      }
      setLight("idle");
      setAnswerStart(Date.now());
      const question = finalQuestion as Message | null;
      if (question) void voice(question.content, question.kind === "closing");
    } catch (reason) {
      setError((reason as Error).message);
      setLight("idle");
      api.session(current.id).then((data) => { setSession(data); setMessages(data.messages); }).catch(() => undefined);
      if (!finalSession) setDraft(text);
    } finally {
      setBusy(false);
      window.setTimeout(() => input.current?.focus(), 30);
    }
  }, [answerStart, voice]);
  sendRef.current = send;

  async function askHint() {
    if (!session || hintBusy) return;
    setHintBusy(true);
    try {
      setHint(await api.hint(session.id));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setHintBusy(false);
    }
  }

  async function endEarly() {
    if (!session) return;
    setConfirmEnd(false);
    stopSpeaking();
    recordingRef.current?.cancel();
    const data = await api.end(session.id).catch((reason: Error) => { setError(reason.message); return null; });
    if (data) go(`/review/${session.id}`);
  }

  function toggle(kind: "voiceOut" | "handsFree" | "blind") {
    if (kind === "voiceOut") {
      const next = !voiceOut;
      setVoiceOut(next);
      setPref("voiceOut", next);
      if (!next) stopSpeaking();
    } else if (kind === "handsFree") {
      const next = !handsFree;
      setHandsFree(next);
      setPref("handsFree", next);
      if (next && !busy && !complete) void beginRecording(true);
      if (!next && recordingRef.current) void finishRecording(false);
    } else {
      const next = !blind;
      setBlind(next);
      setPref("blind", next);
    }
  }

  // Speak the opening line once when the room first loads.
  const greeted = useRef(false);
  useEffect(() => {
    if (!session || greeted.current) return;
    greeted.current = true;
    const opening = session.messages.length === 1 ? session.messages[0] : null;
    if (opening) {
      const timer = window.setTimeout(() => void voice(opening.content, false), 450);
      return () => window.clearTimeout(timer);
    }
  }, [session, voice]);

  function onKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!busy) void send(draft);
    }
  }

  useEffect(() => {
    const onGlobal = (event: KeyboardEvent) => {
      if (event.key === "Escape" && recordingRef.current) void finishRecording(false);
      else if ((event.key === "t" || event.key === "T") && recordingRef.current && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        typeInstead();
      }
    };
    window.addEventListener("keydown", onGlobal);
    return () => window.removeEventListener("keydown", onGlobal);
  }, [finishRecording, typeInstead]);

  if (error && !session) {
    return (
      <div className="empty">
        <GhostLight size={110} state="off" />
        <h1>That interview isn't here.</h1>
        <p>{error}</p>
        <a className="primary" href="#/new">Set up a new rehearsal</a>
      </div>
    );
  }
  if (!session) {
    return <div className="loading"><GhostLight size={100} state="thinking" /><p>Opening the rehearsal room…</p></div>;
  }

  const activeTopic = session.active != null ? session.topics[session.active] : null;
  const words = draft.trim() ? draft.trim().split(/\s+/).length : 0;
  const zone = words === 0 ? "none" : words < 40 ? "short" : words <= 170 ? "good" : "long";
  const zoneLabel = { none: "", short: "a bit short", good: "good length", long: "getting long" }[zone];
  const answerSecs = (now - answerStart) / 1000;
  const lightState: LightState = recording ? "listening" : busy ? (messages.some((m) => m.streaming && m.content) ? "speaking" : "thinking") : light;
  const elapsed = clock((now - started) / 1000);

  return (
    <div className={`room ${coachOpen ? "coach-open" : ""}`}>
      {/* ---------------------------------------------------------------- running order */}
      <aside className="rail rail-left" aria-label="Running order">
        <div className="rail-head">
          <p className="rail-kicker">{MODE_LABEL[session.mode]}</p>
          <h1 className="rail-title">{session.title}</h1>
          <p className="rail-sub">{session.config.personaName}</p>
          {session.config.areas && session.config.areas.length > 0 && (
            <div className="rail-areas">{session.config.areas.map((a) => <span key={a} className="chip">{AREA_LABEL[a] ?? a}</span>)}</div>
          )}
        </div>
        <ol className="running">
          {session.topics.map((topic, index) => (
            <li key={topic.id} className={`run run-${topic.status} ${session.active === index ? "run-active" : ""}`}>
              <span className="run-mark" title={STATUS_LABEL[topic.status]}><StatusIcon status={topic.status} /></span>
              <div className="run-body">
                <strong>{topic.title}</strong>
                <span>{KIND_LABEL[topic.kind] ?? topic.kind}{session.active === index ? ", now" : ""}</span>
              </div>
              {!blind && topic.score != null && <span className={`run-score tone-${scoreTone(topic.score)}`}>{topic.score}</span>}
            </li>
          ))}
        </ol>
        <div className="rail-meta">
          <div>
            <span className="meta-label">Difficulty</span>
            <Meter value={session.difficulty} label="Current difficulty" />
            <span className="meta-value">{DIFFICULTY_LABEL[session.difficulty]}</span>
          </div>
          <div>
            <span className="meta-label">Elapsed</span>
            <span className="meta-big">{elapsed}</span>
          </div>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- stage */}
      <section className="stage" aria-label="Interview">
        <div className="stage-bar">
          <div className="stage-progress" aria-label={`${session.answered} of ${session.total} topics done`}>
            {session.topics.map((topic) => <span key={topic.id} className={`pip pip-${topic.status}`} />)}
          </div>
          <div className="toggles">
            <button type="button" className={`toggle ${voiceOut ? "on" : ""}`} onClick={() => toggle("voiceOut")} disabled={!natural && !canSpeak()} aria-pressed={voiceOut} title="Read questions aloud">
              {voiceOut ? <I.Speaker size={16} /> : <I.SpeakerOff size={16} />}<span>Voice</span>
            </button>
            {voiceOut && (natural || canSpeak()) && (
              <label className="voice-pick" title="Interviewer voice">
                <span className="sr-only">Interviewer voice</span>
                <select
                  value={effectiveVoice}
                  onChange={(e) => {
                    const next = e.target.value as VoiceChoice;
                    setVoiceChoice(next);
                    try {
                      localStorage.setItem("rehearsly.voiceChoice", next);
                    } catch {
                      /* ignore */
                    }
                    if (!busy && !recording) {
                      setLight("speaking");
                      void previewVoice(natural ? next : "device", session.config.persona, setSpeakLevel).then(() => setLight("idle"));
                    }
                  }}
                >
                  {(natural ? (["hannah", "troy", "austin", "device"] as VoiceChoice[]) : (["device"] as VoiceChoice[])).map((v) => (
                    <option key={v} value={v}>{VOICE_LABEL[v]}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" className={`toggle ${handsFree ? "on" : ""}`} onClick={() => toggle("handsFree")} aria-pressed={handsFree} title="Listen automatically after each question and send when you stop talking" disabled={complete}>
              <I.Wave size={16} /><span>Hands-free</span>
            </button>
            <button type="button" className={`toggle ${blind ? "on" : ""}`} onClick={() => toggle("blind")} aria-pressed={blind} title="Hide grades until the review, like a real interview">
              {blind ? <I.EyeOff size={16} /> : <I.Eye size={16} />}<span>{blind ? "Grades hidden" : "Grades shown"}</span>
            </button>
            <button type="button" className="toggle coach-toggle" onClick={() => setCoachOpen((v) => !v)} aria-expanded={coachOpen}>
              <I.Bulb size={16} /><span>Coach</span>
            </button>
            {!complete && (
              <button type="button" className="toggle" onClick={() => setConfirmEnd(true)} title="Finish now and get a review">
                <I.Flag size={16} /><span>End</span>
              </button>
            )}
          </div>
        </div>

        <div className="script-light">
          <GhostLight size={92} state={lightState} level={recording ? level : speakLevel} />
          {blockedRetry && (
            <button
              type="button"
              className="tap-to-hear"
              onClick={() => {
                const retry = blockedRetry;
                setBlockedRetry(null);
                setLight("speaking");
                retry();
              }}
            >
              <I.Speaker size={15} /> Tap to hear the question
            </button>
          )}
        </div>
        <div className="script" ref={scroller}>
          {messages.map((message) => {
            const isLast = message.id === lastInterviewer?.id;
            if (message.role === "interviewer") {
              return (
                <div key={message.id} className={`line line-them ${isLast ? "line-spot" : ""} ${message.kind === "followup" ? "line-followup" : ""}`}>
                  <span className="cue-name">
                    <span>Interviewer{message.kind === "followup" ? ", following up" : ""}</span>
                    {!message.streaming && message.content && (natural || canSpeak()) && (
                      <button type="button" className="replay" onClick={() => speakNatural(message.content, { voice: effectiveVoice, style: session.config.persona, onStart: () => setLight("speaking"), onLevel: setSpeakLevel }).then(() => setLight("idle"))} aria-label="Hear this again" title="Hear this again">
                        <I.Speaker size={14} />
                      </button>
                    )}
                  </span>
                  <p>
                    {message.content || <span className="typing" aria-label="Interviewer is thinking"><i /><i /><i /></span>}
                    {message.streaming && message.content && <span className="caret" />}
                  </p>
                </div>
              );
            }
            const a = message.assessment;
            return (
              <div key={message.id} className="line line-you">
                <span className="cue-name">
                  <span>You{message.via === "voice" ? ", spoken" : ""}</span>
                  {a && !blind && (
                    <span className={`grade tone-${scoreTone(a.score)}`} title="Grade for this answer">
                      {a.status === "skipped" ? "Skipped" : `${a.score}/10`}
                    </span>
                  )}
                </span>
                <p>{message.content}</p>
                {a && !blind && (a.status === "skipped" ? null : (a.score >= 7 ? a.strength : a.gap) ? (
                  <p className={`inline-note tone-${scoreTone(a.score)}`}>
                    {a.score >= 7 ? <I.Check size={14} /> : <I.Half size={14} />}
                    {a.score >= 7 ? a.strength : a.gap}
                  </p>
                ) : null)}
              </div>
            );
          })}
          {busy && !messages.some((m) => m.streaming) && (
            <div className="line line-them line-wait">
              <span className="cue-name">Interviewer</span>
              <p><span className="typing" aria-label="Interviewer is thinking"><i /><i /><i /></span></p>
            </div>
          )}
          {complete && (
            <div className="curtain">
              <p>That's the end of the interview.</p>
              <a className="primary" href={`#/review/${session.id}`}>See your review</a>
              <PracticeNext company={session.config.company ?? ""} role={session.role} compact />
            </div>
          )}
        </div>

        {!complete && (
          <div className="composer-wrap">
            {hint && (
              <div className="hint" role="note">
                <button type="button" className="icon-btn hint-close" onClick={() => setHint(null)} aria-label="Close hint"><I.Close size={14} /></button>
                <p><I.Bulb size={15} /> {hint.hint}</p>
                {hint.structure.length > 0 && <ol>{hint.structure.map((step) => <li key={step}>{step}</li>)}</ol>}
              </div>
            )}
            {error && <p className="error" role="alert">{error}</p>}
            <div className={`composer ${recording ? "composer-rec" : ""}`}>
              {recording ? (
                <div className="listening" aria-live="polite">
                  <div className="wave" aria-hidden="true">
                    {levels.current.map((value, i) => <span key={i} style={{ transform: `scaleY(${0.08 + value * 0.92})` }} />)}
                  </div>
                  <span>{handsFree ? "Listening. Pause to send." : "Listening. Press stop when you're done."} {clock(answerSecs)}</span>
                  <button type="button" className="tool type-instead" onClick={typeInstead}>
                    <I.Keyboard size={15} />Type instead
                  </button>
                </div>
              ) : (
                <textarea
                  ref={input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKey}
                  placeholder={transcribing ? "Transcribing your answer…" : session.active == null ? "Introduce yourself…" : "Type your answer, or press the mic to speak it"}
                  rows={3}
                  disabled={transcribing}
                  aria-label="Your answer"
                />
              )}
              {!recording && (
                <div className={`word-meter zone-${zone}`} aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (words / 200) * 100)}%` }} />
                  <i style={{ left: "20%" }} />
                  <i style={{ left: "85%" }} />
                </div>
              )}
              <div className="composer-bar">
                <div className="composer-tools">
                  <button type="button" className="tool" onClick={askHint} disabled={busy || hintBusy || !!recording}>
                    <I.Bulb size={15} />{hintBusy ? "Thinking…" : "Hint"}
                  </button>
                  {session.active != null && (
                    <button type="button" className="tool" onClick={() => send("pass")} disabled={busy || !!recording}>
                      <I.Skip size={15} />Skip
                    </button>
                  )}
                  <span className="composer-count">{words ? `${words} words, ${zoneLabel}, ` : ""}{clock(answerSecs)}</span>
                </div>
                <div className="composer-actions">
                  <button
                    type="button"
                    className={`mic ${recording ? "mic-on" : ""}`}
                    onClick={() => (recording ? finishRecording(handsFree) : beginRecording(false))}
                    disabled={busy || transcribing}
                    aria-label={recording ? "Stop recording" : "Answer by voice"}
                    title={recording ? "Stop (Esc)" : "Answer by voice"}
                    style={recording ? { boxShadow: `0 0 0 ${4 + level * 14}px rgba(111,168,255,${0.18 + level * 0.25})` } : undefined}
                  >
                    {recording ? <I.StopIcon size={18} /> : <I.Mic size={20} />}
                  </button>
                  <button type="button" className="primary send" onClick={() => send(draft)} disabled={busy || !draft.trim() || !!recording} title="Send (Ctrl/⌘ + Enter)">
                    <I.Send size={16} />Send
                  </button>
                </div>
              </div>
            </div>
            <p className="kbd-hint">Ctrl / ⌘ + Enter to send{recording ? ", Esc to stop recording, T to type instead" : ""}</p>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- coach */}
      <aside className="rail rail-right" aria-label="Coach notes">
        <button type="button" className="icon-btn coach-close" onClick={() => setCoachOpen(false)} aria-label="Close coach"><I.Close size={16} /></button>
        {blind ? (
          <div className="coach-blind">
            <I.EyeOff size={22} />
            <h2>Grades are hidden</h2>
            <p>Like the real thing. Everything is still being recorded for your review.</p>
          </div>
        ) : lastAssessed?.assessment ? (
          <CoachCard message={lastAssessed} assessment={lastAssessed.assessment} mode={session.mode} />
        ) : (
          <Briefing session={session} />
        )}
        {!blind && lastAnswer?.delivery && <DeliveryCard message={lastAnswer} />}
        {activeTopic && !blind && (
          <div className="coach-block coach-now">
            <h3>Now on</h3>
            <p className="coach-topic">{activeTopic.title}</p>
            {activeTopic.evidence && <p className="coach-evidence">From your material: “{activeTopic.evidence}”</p>}
          </div>
        )}
      </aside>

      {wrapUp && (
        <div className="prep" role="dialog" aria-modal="true" aria-labelledby="wrap-title" onClick={() => setWrapUp(false)}>
          <div className="prep-card wrap-card" onClick={(e) => e.stopPropagation()}>
            <div className="prep-head">
              <GhostLight size={70} state="idle" />
              <div>
                <h2 id="wrap-title">That's a wrap.</h2>
                <p>You answered {session.answered} of {session.total} topics. Your review is ready.</p>
              </div>
            </div>
            <PracticeNext company={session.config.company ?? ""} role={session.role} />
            <div className="prep-actions">
              <button type="button" className="ghost-btn" onClick={() => setWrapUp(false)}>Stay here</button>
              <a className="primary" href={`#/review/${session.id}`} autoFocus>See my review</a>
            </div>
          </div>
        </div>
      )}

      {confirmEnd && (
        <div className="prep" role="dialog" aria-modal="true" aria-labelledby="end-title">
          <div className="prep-card small">
            <h2 id="end-title">End the interview now?</h2>
            <p>You've answered {session.answered} of {session.total} topics. Your review will be marked provisional.</p>
            <div className="prep-actions">
              <button type="button" className="ghost-btn" onClick={() => setConfirmEnd(false)} autoFocus>Keep going</button>
              <button type="button" className="primary" onClick={endEarly} disabled={session.exchanges < 2}>End and review</button>
            </div>
            {session.exchanges < 2 && <p className="muted">Answer at least one question after your introduction first.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function CoachCard({ message, assessment, mode }: { message: Message; assessment: Assessment; mode: string }) {
  const [open, setOpen] = useState(false);
  const tone = scoreTone(assessment.score);
  return (
    <div className="coach-block coach-grade" key={message.id}>
      <div className={`grade-ring tone-${tone}`} style={{ ["--p" as string]: assessment.status === "skipped" ? 0 : assessment.score / 10 }} aria-hidden="true" />
      <h3>Your last answer</h3>
      <div className="grade-row">
        <span className={`grade-big tone-${tone}`}>{assessment.status === "skipped" ? "–" : <CountUp value={assessment.score} duration={700} />}</span>
        <div>
          <strong>{assessment.status === "covered" ? "Covered" : assessment.status === "skipped" ? "Skipped" : assessment.status === "off_topic" ? "Off topic" : "A bit thin"}</strong>
          <span>out of 10</span>
        </div>
      </div>
      {assessment.check && (
        <p className={`grade-check ${assessment.check.agree ? "agree" : "split"}`} title={assessment.check.reason || undefined}>
          <I.Users size={13} />
          {assessment.check.agree
            ? `Two AI graders agreed: ${assessment.check.first} and ${assessment.check.second}`
            : `Graders split ${assessment.check.first} vs ${assessment.check.second}, so you get the average`}
          <small>{assessment.check.firstBy === assessment.check.secondBy ? assessment.check.firstBy : `${assessment.check.firstBy} + ${assessment.check.secondBy}`}</small>
        </p>
      )}
      {assessment.quote && <blockquote>“{assessment.quote}”</blockquote>}
      {assessment.strength && <p className="coach-good"><I.Check size={14} /> {assessment.strength}</p>}
      {assessment.gap && <p className="coach-gap"><I.Half size={14} /> {assessment.gap}</p>}
      {(mode === "behavioral" || Object.values(assessment.star).some(Boolean)) && (
        <div className="star" aria-label="STAR structure">
          {(["situation", "task", "action", "result"] as const).map((key) => (
            <span key={key} className={assessment.star[key] ? "on" : ""} title={assessment.star[key] ? "Present" : "Missing"}>
              {key[0].toUpperCase()}<small>{key}</small>
            </span>
          ))}
        </div>
      )}
      {assessment.sharper && (
        <div className="sharper">
          <button type="button" className="link" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide the stronger version" : "Show a stronger version"}
          </button>
          {open && <p>{assessment.sharper}</p>}
        </div>
      )}
    </div>
  );
}

function DeliveryCard({ message }: { message: Message }) {
  const d = message.delivery!;
  const fillers = Object.entries(d.fillers);
  return (
    <div className="coach-block">
      <h3>Delivery</h3>
      <dl className="stats">
        <div><dt>Words</dt><dd>{d.words}</dd></div>
        <div><dt>{d.wpm ? "Pace" : "Sentences"}</dt><dd>{d.wpm ? <>{d.wpm}<small> wpm</small></> : d.sentences}</dd></div>
        <div><dt>Fillers</dt><dd>{d.fillerCount}</dd></div>
        <div><dt>Clarity</dt><dd>{d.clarity}</dd></div>
      </dl>
      {fillers.length > 0 && <p className="muted small">Fillers: {fillers.map(([w, n]) => `“${w}” ×${n}`).join(", ")}</p>}
      {d.numbers === 0 && d.words > 25 && <p className="muted small">No numbers in that answer. A metric makes impact concrete.</p>}
      {d.ownership.we > d.ownership.i * 2 && d.ownership.we > 2 && <p className="muted small">Lots of “we”, little “I”. Say what you did yourself.</p>}
    </div>
  );
}

function Briefing({ session }: { session: Session }) {
  const p = session.profile;
  return (
    <div className="coach-block">
      <h3>Before you start</h3>
      <p className="muted">Answer the way you would in the room. After each answer you'll see a grade, the gap, and a stronger version here.</p>
      {p && (p.skills.length > 0 || p.projects.length > 0) && (
        <>
          <h3 className="mt">What the interviewer read</h3>
          {p.headline && <p className="small">{p.headline}</p>}
          <div className="chips">
            {p.skills.slice(0, 10).map((skill) => <span key={skill} className="chip">{skill}</span>)}
          </div>
        </>
      )}
      {session.gaps && session.gaps.match != null && (
        <>
          <h3 className="mt">Job match {session.gaps.match}%</h3>
          <div className="chips">
            {session.gaps.missing.map((item) => <span key={item} className="chip chip-pink">Missing: {item}</span>)}
            {session.gaps.matched.map((item) => <span key={item} className="chip chip-mint">{item}</span>)}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { api, type Message, type Review, type Session } from "../lib/api";
import { DIFFICULTY_LABEL, KIND_LABEL, MODE_LABEL, scoreTone, STATUS_LABEL, when } from "../lib/format";
import { GhostLight } from "../components/GhostLight";
import { Confetti, CountUp } from "../components/Motion";
import { go } from "../lib/router";
import { PracticeNext } from "../components/PracticeNext";
import { Radar, Steps } from "../components/Charts";
import * as I from "../components/Icons";

type Pair = { question: Message | undefined; answer: Message };

function toMarkdown(review: Review, session: Session, pairs: Pair[]): string {
  const lines = [
    `# Rehearsly review: ${session.title}`,
    `${MODE_LABEL[session.mode]}, ${session.config.personaName}, ${new Date(session.createdAt * 1000).toLocaleString()}`,
    "",
    `**Practice score: ${review.score}/100 (${review.readiness})**${review.provisional ? " (provisional, interview not finished)" : ""}`,
    "AI practice feedback; scores summarize this rehearsal and do not predict hiring outcomes.",
    "",
    `> ${review.headline}`,
    "",
    review.summary,
    "",
    "## Strengths",
    ...review.strengths.map((s) => `- ${s}`),
    "",
    "## To improve",
    ...review.improvements.map((s) => `- ${s}`),
    "",
    "## Practice plan",
    ...review.plan.map((p, i) => `${i + 1}. **${p.title}**: ${p.detail}`),
    "",
    "## Competencies",
    ...review.competencies.map((c) => `- ${c.label}: ${c.score}/10`),
    "",
    "## Question by question",
  ];
  pairs.forEach(({ question, answer }, i) => {
    const a = answer.assessment!;
    lines.push("", `### ${i + 1}. ${question?.content ?? ""}`, "", `**Your answer (${a.score}/10):** ${answer.content}`, "");
    if (a.gap) lines.push(`**Missing:** ${a.gap}`, "");
    if (a.sharper) lines.push(`**Stronger version:** ${a.sharper}`);
  });
  return lines.join("\n");
}

export function ReviewPage({ id }: { id: string }) {
  const [review, setReview] = useState<Review | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [drilling, setDrilling] = useState(false);

  async function drill() {
    setDrilling(true);
    setError("");
    try {
      const next = await api.drill(id);
      go(`/room/${next.id}`);
    } catch (reason) {
      setError((reason as Error).message);
      setDrilling(false);
    }
  }

  const load = (refresh = false) => {
    setBusy(true);
    setError("");
    api
      .review(id, refresh)
      .then((data) => {
        setReview(data);
        if (data.session) setSession(data.session);
      })
      .catch((reason: Error) => {
        setError(reason.message);
        api.session(id).then(setSession).catch(() => undefined);
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pairs: Pair[] = useMemo(() => {
    if (!session) return [];
    const out: Pair[] = [];
    session.messages.forEach((message, index) => {
      if (message.role === "candidate" && message.assessment) {
        const question = [...session.messages.slice(0, index)].reverse().find((m) => m.role === "interviewer");
        out.push({ question, answer: message });
      }
    });
    return out;
  }, [session]);

  async function copy() {
    if (!review || !session) return;
    try {
      await navigator.clipboard.writeText(toMarkdown(review, session, pairs));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy to the clipboard in this browser.");
    }
  }

  function rehearseAgain() {
    if (!session) return;
    try {
      const saved = JSON.parse(localStorage.getItem("rehearsly.setup") || "{}");
      localStorage.setItem("rehearsly.setup", JSON.stringify({ ...saved, mode: session.mode, role: session.role, persona: session.config.persona }));
    } catch {
      /* ignore */
    }
    window.location.hash = "/new";
  }

  if (busy && !review) {
    return (
      <div className="loading">
        <GhostLight size={110} state="thinking" />
        <p>Preparing your practice feedback…</p>
      </div>
    );
  }

  if (!review || !session) {
    return (
      <div className="empty">
        <GhostLight size={110} state="off" />
        <h1>No review yet.</h1>
        <p>{error || "This interview couldn't be found."}</p>
        {session && !session.complete ? <a className="primary" href={`#/room/${id}`}>Back to the interview</a> : <a className="primary" href="#/new">Set up a new rehearsal</a>}
      </div>
    );
  }

  const tone = scoreTone(review.score, 100);
  const topicFor = (message: Message) => (message.topic != null ? session.topics[message.topic] : undefined);

  return (
    <article className="review">
      {review.score >= 70 && <Confetti />}
      <header className="verdict">
        <div className="verdict-score">
          <div className="marquee" aria-hidden="true">
            <span className="marquee-bulbs top" />
            <span className="marquee-bulbs bottom" />
            <span className="marquee-bulbs left" />
            <span className="marquee-bulbs right" />
          </div>
          <GhostLight size={170} state="idle" />
          <CountUp value={review.score} className={`score-numeral tone-${tone}`} delay={250} />
          <span className="score-out">practice score / 100</span>
        </div>
        <div className="verdict-copy">
          <p className="verdict-meta">
            {MODE_LABEL[session.mode]} for {session.title}, with a {session.config.personaName.toLowerCase()}, {when(session.createdAt)}
          </p>
          <h1>{review.headline}</h1>
          <p className={`readiness tone-${tone}`}>{review.readiness}</p>
          <p className="muted small">AI practice feedback. Scores summarize this rehearsal and do not predict hiring outcomes.</p>
          {review.summary && <p className="verdict-summary">{review.summary}</p>}
          {review.provisional && (
            <p className="muted">Provisional. You covered {session.answered} of {session.total} topics, and unanswered topics aren't counted.</p>
          )}
          <div className="verdict-actions no-print">
            {pairs.some(({ answer }) => (answer.assessment?.score ?? 10) < 7) && (
              <button type="button" className="primary" onClick={drill} disabled={drilling}>
                <I.Target size={16} />{drilling ? "Preparing fresh questions…" : "Drill my weak spots"}
              </button>
            )}
            <button type="button" className={pairs.some(({ answer }) => (answer.assessment?.score ?? 10) < 7) ? "ghost-btn" : "primary"} onClick={rehearseAgain}><I.Refresh size={16} />Rehearse again</button>
            <button type="button" className="ghost-btn" onClick={() => window.print()}><I.Print size={16} />Save as PDF</button>
            <button type="button" className="ghost-btn" onClick={copy}><I.Copy size={16} />{copied ? "Copied" : "Copy as Markdown"}</button>
            <button type="button" className="link" onClick={() => load(true)} disabled={busy}>{busy ? "Rewriting…" : "Regenerate feedback"}</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </header>

      <section className="stagger no-print" style={{ ["--i" as string]: 0 }}>
        <PracticeNext company={session.config.company ?? ""} role={session.role} />
      </section>

      {review.trust && (
        <section className="panel stagger trust" style={{ ["--i" as string]: 1 }}>
          <div className="trust-head">
            <div>
              <h2>Grader agreement</h2>
              <p className="muted">
                {review.trust.answers} answers received two grades{review.trust.crossModel ? ` from different model families (${review.trust.judges.join(" and ")})` : ` (${review.trust.judges.join(", ")})`}.
                Neither grader saw the other's score. Agreement measures consistency, not correctness.
              </p>
            </div>
            <div className={`trust-big tone-${review.trust.within1 >= 80 ? "good" : review.trust.within1 >= 60 ? "mid" : "low"}`}>
              <strong><CountUp value={review.trust.within1} duration={900} />%</strong>
              <span>agreed within 1 point</span>
            </div>
          </div>
          <dl className="stats">
            <div><dt>Answers checked</dt><dd>{review.trust.answers}</dd></div>
            <div><dt>Exact match</dt><dd>{review.trust.exact}<small>%</small></dd></div>
            <div><dt>Average gap</dt><dd>{review.trust.meanGap}<small> pts</small></dd></div>
            <div><dt>Correlation</dt><dd>{review.trust.correlation ?? "–"}</dd></div>
          </dl>
          <div className="trust-pairs" role="img" aria-label={review.trust.pairs.map((p, i) => `Answer ${i + 1}: ${p.first} and ${p.second}`).join("; ")}>
            {review.trust.pairs.map((p, i) => (
              <div key={i} className={`trust-pair ${Math.abs(p.first - p.second) <= 1 ? "agree" : "split"}`}>
                <span className="trust-track">
                  <i className="trust-span" style={{ left: `${Math.min(p.first, p.second) * 10}%`, width: `${Math.abs(p.first - p.second) * 10}%` }} />
                  <b className="g1" style={{ left: `${p.first * 10}%` }} title={`First grader: ${p.first}`} />
                  <b className="g2" style={{ left: `${p.second * 10}%` }} title={`Second grader: ${p.second}`} />
                </span>
                <small>A{i + 1}</small>
              </div>
            ))}
            <div className="trust-legend"><span><b className="g1" />First grader</span><span><b className="g2" />Second grader</span><span>0 to 10</span></div>
          </div>
        </section>
      )}

      <section className="review-grid stagger" style={{ ["--i" as string]: 1 }}>
        <div className="panel">
          <h2>Competencies</h2>
          <Radar items={review.competencies} />
        </div>
        <div className="panel">
          <h2>How you came across</h2>
          <dl className="stats stats-big">
            <div><dt>Answers</dt><dd>{review.delivery.answers}</dd></div>
            <div><dt>Avg length</dt><dd>{review.delivery.avgWords}<small> words</small></dd></div>
            <div><dt>Pace</dt><dd>{review.delivery.wpm ?? "–"}{review.delivery.wpm && <small> wpm</small>}</dd></div>
            <div><dt>Clarity</dt><dd>{review.delivery.clarity ?? "–"}</dd></div>
            <div><dt>Fillers</dt><dd>{review.delivery.fillerCount}</dd></div>
            <div><dt>Numbers cited</dt><dd>{review.delivery.numbers}</dd></div>
          </dl>
          {Object.keys(review.delivery.fillers).length > 0 && (
            <p className="muted small">Most used: {Object.entries(review.delivery.fillers).map(([w, n]) => `“${w}” ×${n}`).join(", ")}</p>
          )}
          {review.difficultyTrail.length > 1 && (
            <div className="trail">
              <h3>Difficulty through the interview</h3>
              <Steps trail={review.difficultyTrail} />
              <p className="muted small">
                Started at {DIFFICULTY_LABEL[review.difficultyTrail[0]]}, peaked at {DIFFICULTY_LABEL[Math.max(...review.difficultyTrail)]}.
              </p>
            </div>
          )}
          {review.star && (
            <div className="trail">
              <h3>STAR structure across answers</h3>
              <div className="star star-wide">
                {(["situation", "task", "action", "result"] as const).map((key) => (
                  <span key={key} className={review.star![key] ? "on" : ""}>
                    {key[0].toUpperCase()}<small>{key} {review.star![key]}/{review.delivery.answers}</small>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="review-two stagger" style={{ ["--i" as string]: 2 }}>
        <div className="panel">
          <h2>What worked</h2>
          <ul className="points points-good">{review.strengths.map((item) => <li key={item}><I.Check size={16} />{item}</li>)}</ul>
        </div>
        <div className="panel">
          <h2>What to work on</h2>
          <ul className="points points-gap">{review.improvements.map((item) => <li key={item}><I.Half size={16} />{item}</li>)}</ul>
        </div>
      </section>

      {review.plan.length > 0 && (
        <section className="panel">
          <h2>Your practice plan</h2>
          <ol className="plan">
            {review.plan.map((step, index) => (
              <li key={step.title}>
                <span className="plan-n">{index + 1}</span>
                <div><strong>{step.title}</strong><p>{step.detail}</p></div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel">
        <h2>Question by question</h2>
        <ol className="qa">
          {pairs.map(({ question, answer }, index) => {
            const a = answer.assessment!;
            const topic = topicFor(answer);
            const isOpen = open === answer.id;
            return (
              <li key={answer.id} id={`qa-${answer.id}`} className={isOpen ? "open" : ""}>
                <button type="button" className="qa-head" onClick={() => setOpen(isOpen ? null : answer.id)} aria-expanded={isOpen}>
                  <span className={`qa-score tone-${scoreTone(a.score)}`}>{a.status === "skipped" ? "–" : a.score}</span>
                  <span className="qa-q">
                    <small>{topic ? `${topic.title}, ${KIND_LABEL[topic.kind] ?? topic.kind}` : `Question ${index + 1}`}{question?.kind === "followup" ? ", follow-up" : ""}</small>
                    {question?.content}
                  </span>
                  <I.Chevron size={16} />
                </button>
                <div className="qa-body">
                  <div className="qa-col">
                    <h3>You said</h3>
                    <p>{answer.content}</p>
                    {answer.delivery && (
                      <p className="muted small">{answer.delivery.words} words{answer.delivery.wpm ? `, ${answer.delivery.wpm} wpm` : ""}, {answer.delivery.fillerCount} fillers</p>
                    )}
                  </div>
                  <div className="qa-col">
                    {a.check && <p className="muted small">Graded {a.check.first} and {a.check.second} by two independent graders{a.check.agree ? "" : ", averaged"}.</p>}
                    {a.strength && <p className="coach-good"><I.Check size={14} /> {a.strength}</p>}
                    {a.gap && <p className="coach-gap"><I.Half size={14} /> {a.gap}</p>}
                    {a.sharper && (<><h3>A stronger version</h3><p className="sharper-text">{a.sharper}</p></>)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="panel">
        <h2>Topic coverage</h2>
        <ul className="coverage">
          {session.topics.map((topic) => (
            <li key={topic.id} className={`cov cov-${topic.status}`}>
              <span className="cov-status">{STATUS_LABEL[topic.status]}</span>
              <strong>{topic.title}</strong>
              <span className="cov-score">{topic.score != null ? `${topic.score}/10` : "–"}</span>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}

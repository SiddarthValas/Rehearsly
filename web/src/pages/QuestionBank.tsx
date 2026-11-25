import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Bank, type BankQuestion } from "../lib/api";
import { banks, prettyDate, when } from "../lib/format";
import { go } from "../lib/router";
import { GhostLight } from "../components/GhostLight";
import * as I from "../components/Icons";


type Stage = { label: string; done: boolean };

export function QuestionBank({ company: initialCompany, role: initialRole, auto }: { company: string; role: string; auto: boolean }) {
  const [company, setCompany] = useState(initialCompany);
  const [role, setRole] = useState(initialRole);
  const [bank, setBank] = useState<Bank | null>(() => (initialCompany ? banks.find(initialCompany, initialRole) ?? null : null));
  const [stages, setStages] = useState<Stage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [subject, setSubject] = useState<string>("All");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);
  const [saved, setSaved] = useState<Bank[]>(() => banks.all());
  const abort = useRef<AbortController | null>(null);

  async function search(refresh = false, c = company, r = role) {
    if (c.trim().length < 2) {
      setError("Enter a company name.");
      return;
    }
    abort.current?.abort();
    abort.current = new AbortController();
    setBusy(true);
    setError("");
    setStages([]);
    setPicked(new Set());
    setSubject("All");
    try {
      await api.questionBank(
        { company: c.trim(), role: r.trim(), refresh },
        (event) => {
          if (event.type === "stage") setStages((list) => [...list.map((s) => ({ ...s, done: true })), { label: event.label, done: !("pending" in event && event.pending) }]);
          if (event.type === "bank") {
            setBank(event.bank);
            banks.save(event.bank);
            setSaved(banks.all());
          }
        },
        abort.current.signal,
      );
    } catch (reason) {
      if ((reason as Error).name !== "AbortError") setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (auto && initialCompany && !banks.find(initialCompany, initialRole)) void search(false, initialCompany, initialRole);
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = useMemo(() => bank?.groups.flatMap((g) => g.questions) ?? [], [bank]);
  const visible = useMemo(() => (bank ? bank.groups.filter((g) => subject === "All" || g.subject === subject) : []), [bank, subject]);

  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 12) next.add(id);
      return next;
    });
  }

  function toggleGroup(questions: BankQuestion[]) {
    setPicked((current) => {
      const next = new Set(current);
      const allOn = questions.every((q) => next.has(q.id));
      questions.forEach((q) => (allOn ? next.delete(q.id) : next.size < 12 && next.add(q.id)));
      return next;
    });
  }

  async function practise() {
    if (!bank || !picked.size) return;
    setStarting(true);
    setError("");
    const chosen = all.filter((q) => picked.has(q.id)).map((q) => ({ question: q.question, subject: q.subject }));
    const form = new FormData();
    Object.entries({ mode: "bank", company: bank.company, role: bank.role, persona: "professional", questions: JSON.stringify(chosen) }).forEach(([k, v]) => form.set(k, v));
    try {
      let id = "";
      await api.create(form, (event) => {
        if (event.type === "session") id = event.session.id;
      });
      if (id) go(`/room/${id}`);
    } catch (reason) {
      setError((reason as Error).message);
      setStarting(false);
    }
  }

  return (
    <div className="bank">
      <header className="bank-head">
        <h1>
          Find questions to practise.
        </h1>
        <p className="lede">
          Enter a company and role. Rehearsly searches Glassdoor, Reddit, LeetCode Discuss, GeeksforGeeks, AmbitionBox and Quora for questions candidates reported, then groups them by subject and date.
        </p>
        <form
          className="bank-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search(false);
          }}
        >
          <label>
            <span>Company</span>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Google, Amazon, Deloitte, Zomato…" maxLength={80} autoFocus={!initialCompany} />
          </label>
          <label>
            <span>Role <em>optional</em></span>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Data Scientist, SDE intern…" maxLength={80} />
          </label>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? <span className="spinner" /> : <I.Target size={16} />}
            {busy ? "Searching…" : "Find questions"}
          </button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
      </header>
{busy && (
          <div key="busy" className="bank-progress">
            <GhostLight size={70} state="thinking" />
            <ul aria-live="polite">
              {stages.map((stage) => (
                <li key={stage.label} className={stage.done ? "done" : ""}>
                  <span className="prep-mark">{stage.done ? <I.Check size={14} /> : <span className="spinner" />}</span>
                  {stage.label}
                </li>
              ))}
            </ul>
            <p className="muted small">Live searches usually take 15 to 40 seconds.</p>
          </div>
        )}
      

      {!busy && bank && (
        <section key={bank.fetchedAt} className="bank-results">
          <div className="bank-overview">
            <div>
              <p className="bank-meta">
                {bank.count} questions for {bank.company}
                {bank.role ? `, ${bank.role}` : ""}. Searched {when(bank.fetchedAt)}.{" "}
                <button type="button" className="link" onClick={() => search(true, bank.company, bank.role)}>Search again</button>
              </p>
              {bank.resolved && (bank.resolved.program || bank.resolved.company.toLowerCase() !== bank.company.toLowerCase()) && (
                <p className="bank-resolved">
                  Searched for <strong>{bank.resolved.company}</strong>
                  {bank.resolved.program ? <>, <strong>{bank.resolved.program}</strong></> : null}
                  {bank.resolved.aliases.length > 0 ? ` (also ${bank.resolved.aliases.slice(0, 3).join(", ")})` : ""}.
                </p>
              )}
              {bank.scopes && (bank.scopes.company > 0 || bank.scopes.similar > 0) && (
                <p className="bank-warn">
                  {bank.scopes.exact} matched exactly.
                  {bank.scopes.company > 0 && ` ${bank.scopes.company} were asked at ${bank.resolved?.company ?? bank.company} for other teams or roles.`}
                  {bank.scopes.similar > 0 && ` ${bank.scopes.similar} come from similar companies.`} They're tagged below.
                </p>
              )}
              {!bank.live && <p className="bank-warn">Live search is off on this server, so these come from the model's own knowledge and may be dated.</p>}
              {bank.summary && <p className="bank-summary">{bank.summary}</p>}
            </div>
            {bank.rounds.length > 0 && (
              <ol className="rounds" aria-label="Interview rounds">
                {bank.rounds.map((round, i) => (
                  <li key={round}>
                    <span>{i + 1}</span>
                    {round}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="subject-filter" role="tablist" aria-label="Filter by subject">
            {["All", ...bank.groups.map((g) => g.subject)].map((name) => {
              const count = name === "All" ? bank.count : bank.groups.find((g) => g.subject === name)?.questions.length ?? 0;
              return (
                <button key={name} type="button" role="tab" aria-selected={subject === name} className={subject === name ? "on" : ""} onClick={() => setSubject(name)}>
                  {name}
                  <small>{count}</small>
                </button>
              );
            })}
          </div>

          <div className="groups">
            {visible.map((group) => {
              const allOn = group.questions.every((q) => picked.has(q.id));
              return (
                <section key={group.subject} className="group">
                  <header>
                    <h2>{group.subject}</h2>
                    <span className="muted small">{group.questions.length} question{group.questions.length === 1 ? "" : "s"}, newest first</span>
                    <button type="button" className="link" onClick={() => toggleGroup(group.questions)}>{allOn ? "Clear" : "Select all"}</button>
                  </header>
                  <ul>
                    {group.questions.map((q) => {
                      const on = picked.has(q.id);
                      return (
                        <li key={q.id} className={on ? "on" : ""}>
                          <button type="button" className="q-pick" onClick={() => toggle(q.id)} aria-pressed={on} aria-label={on ? "Remove from practice set" : "Add to practice set"}>
                            <span className="q-box">{on && <I.Check size={13} />}</span>
                          </button>
                          <div className="q-body" onClick={() => toggle(q.id)}>
                            <p>{q.question}</p>
                            <div className="q-meta">
                              <span className={`q-date ${q.date ? "" : "unknown"}`}><I.Clock size={12} /> {prettyDate(q.date)}</span>
                              {q.scope === "company" && <span className="q-scope">{bank.resolved?.company ?? bank.company}, other roles</span>}
                              {q.scope === "similar" && <span className="q-scope similar">Similar companies</span>}
                              {q.round && <span>{q.round}</span>}
                              {q.url ? (
                                <a href={q.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>{q.source} ↗</a>
                              ) : (
                                q.source && <span>{q.source}</span>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>

          {bank.sources.length > 0 && (
            <details className="bank-sources">
              <summary>{bank.sources.length} pages searched</summary>
              <ul>
                {bank.sources.map((s) => (
                  <li key={s.url}><a href={s.url} target="_blank" rel="noreferrer noopener">{s.site}: {s.title || s.url}</a></li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {!busy && !bank && saved.length > 0 && (
        <section className="bank-saved">
          <h2>Recent searches</h2>
          <div className="saved-grid">
            {saved.map((b) => (
              <button key={`${b.company}|${b.role}`} type="button" className="saved" onClick={() => { setCompany(b.company); setRole(b.role); setBank(b); }}>
                <strong>{b.company}</strong>
                <span>{b.role || "Any role"}</span>
                <small>{b.count} questions, {when(b.fetchedAt)}</small>
              </button>
            ))}
          </div>
        </section>
      )}
{picked.size > 0 && (
          <div className="practice-bar">
            <span>
              <strong>{picked.size}</strong> question{picked.size === 1 ? "" : "s"} selected{picked.size >= 12 ? " (max 12)" : ""}
            </span>
            <button type="button" className="ghost-btn" onClick={() => setPicked(new Set())}>Clear</button>
            <button type="button" className="primary" onClick={practise} disabled={starting}>
              {starting ? <span className="spinner" /> : <I.Mic size={16} />}
              {starting ? "Starting…" : "Practise these"}
            </button>
          </div>
        )}
      
    </div>
  );
}

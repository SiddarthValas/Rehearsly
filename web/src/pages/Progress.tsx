import { useEffect, useState } from "react";
import { api, type History } from "../lib/api";
import { KIND_LABEL, MODE_LABEL, scoreTone, when } from "../lib/format";
import { GhostLight } from "../components/GhostLight";
import { Bars, Trend } from "../components/Charts";
import * as I from "../components/Icons";

export function Progress() {
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = () => api.history().then(setData).catch((reason: Error) => setError(reason.message));
  useEffect(() => { void load(); }, []);

  async function remove(id: string) {
    setConfirm(null);
    try {
      await api.remove(id);
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  if (!data) {
    return error ? (
      <div className="empty"><GhostLight size={100} state="off" /><h1>Couldn't load your progress.</h1><p>{error}</p></div>
    ) : (
      <div className="loading"><GhostLight size={100} state="thinking" /><p>Loading your rehearsals…</p></div>
    );
  }

  if (!data.sessions.length) {
    return (
      <div className="empty">
        <GhostLight size={120} state="idle" cone />
        <h1>No rehearsals yet.</h1>
        <p>Every interview you finish is scored and saved here, so you can watch the numbers climb.</p>
        <a className="primary" href="#/new">Start your first rehearsal</a>
      </div>
    );
  }

  const { stats } = data;
  const first = data.trend[0]?.score;
  const last = data.trend[data.trend.length - 1]?.score;
  const delta = data.trend.length > 1 && first != null && last != null ? last - first : null;
  const kinds = Object.entries(data.byKind).sort((a, b) => b[1] - a[1]);

  return (
    <div className="progress">
      <header className="progress-head">
        <h1>Your progress</h1>
        <dl className="tally">
          <div><dt>Rehearsals</dt><dd>{stats.count}</dd></div>
          <div><dt>Best score</dt><dd>{stats.best ?? "–"}</dd></div>
          <div><dt>Average</dt><dd>{stats.average ?? "–"}</dd></div>
          <div><dt>Answers given</dt><dd>{stats.answers}</dd></div>
          {delta != null && <div><dt>Since your first</dt><dd className={delta >= 0 ? "up" : "down"}>{delta >= 0 ? "+" : ""}{delta}</dd></div>}
        </dl>
      </header>

      <div className="progress-grid">
        {data.trend.length > 0 && (
          <section className="panel">
            <h2>Score per rehearsal</h2>
            <Trend points={data.trend.map((t) => ({ score: t.score, label: t.title, sub: when(t.at) }))} />
          </section>
        )}
        {kinds.length > 0 && (
          <section className="panel">
            <h2>Average by question type</h2>
            <Bars items={kinds.map(([kind, value]) => ({ label: KIND_LABEL[kind] ?? kind, value, max: 10 }))} />
            {kinds.length > 1 && <p className="muted small">Weakest: {KIND_LABEL[kinds[kinds.length - 1][0]] ?? kinds[kinds.length - 1][0]}. Pick it as your focus next time.</p>}
          </section>
        )}
      </div>

      <section className="panel">
        <h2>All rehearsals</h2>
        <ul className="sessions">
          {data.sessions.map((item) => (
            <li key={item.id}>
              <a className="session-link" href={item.complete ? `#/review/${item.id}` : `#/room/${item.id}`}>
                <span className={`session-score tone-${scoreTone(item.score, 100)}`}>{item.score ?? "–"}</span>
                <span className="session-main">
                  <strong>{item.title}</strong>
                  <span>{item.drill ? "Weak-spot drill" : MODE_LABEL[item.mode]}, {when(item.createdAt)}</span>
                </span>
                <span className="session-pips" aria-label={`${item.answered} of ${item.total} topics answered`}>
                  {item.topics.map((t, i) => <span key={i} className={`pip pip-${t.status}`} title={`${t.title}: ${t.score ?? "not answered"}`} />)}
                </span>
                <span className={`session-state ${item.complete ? "" : "live"}`}>{item.complete ? "Review" : "Resume"}</span>
              </a>
              {confirm === item.id ? (
                <span className="confirm">
                  <button type="button" className="link danger" onClick={() => remove(item.id)}>Delete</button>
                  <button type="button" className="link" onClick={() => setConfirm(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className="icon-btn" aria-label={`Delete ${item.title}`} onClick={() => setConfirm(item.id)}><I.Trash size={16} /></button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

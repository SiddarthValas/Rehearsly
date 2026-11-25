import { GhostLight } from "../components/GhostLight";
import { Reveal } from "../components/Motion";
import * as I from "../components/Icons";

const FEATURES = [
  { icon: I.File, title: "Start with your material", text: "Upload your resume or paste a job description. Choose the topics you want to practise." },
  { icon: I.Bulb, title: "Go beyond the first answer", text: "Follow-up questions help you explain your decisions, examples, and results in more detail." },
  { icon: I.Wave, title: "Practise out loud", text: "Type or speak your answers. Optional voice playback and hands-free mode keep the conversation moving." },
  { icon: I.Refresh, title: "Review and try again", text: "Get specific feedback, revisit weak topics, and track your practice scores across rehearsals." },
];

type Origin = { x: number; y: number };

export function Landing({ theme, onToggleTheme }: { theme: "dark" | "light"; onToggleTheme: (origin?: Origin) => void }) {
  const lit = theme === "dark";
  return (
    <div className="landing landing-focused">
      <section className="l-hero">
        <div className="l-hero-copy">
          <button
            type="button"
            className={`ghost-switch ${lit ? "is-on" : "is-off"}`}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onToggleTheme({ x: box.left + box.width / 2, y: box.top + box.height * 0.4 });
            }}
            aria-label={lit ? "Turn the light off (switch to light mode)" : "Turn the light on (switch to dark mode)"}
            title={lit ? "Turn the light off" : "Turn the light on"}
          >
            <GhostLight size={110} cone={lit} state={lit ? "idle" : "off"} />
          </button>
          <Reveal text="Rehearse your next interview." />
          <p className="l-lede">Personalized questions, focused follow-ups, and feedback you can practise with. Work through one answer at a time.</p>
          <div className="l-ctas">
            <a className="primary big-pill" href="#/new">Start rehearsing</a>
            <a className="l-textlink" href="#/progress">Your progress <I.Chevron size={15} /></a>
          </div>
        </div>
      </section>

      <section className="l-section" aria-labelledby="practice-loop">
        <header className="l-head l-center">
          <h2 id="practice-loop">A focused practice loop.</h2>
          <p>Prepare, answer, review, and try again.</p>
        </header>
        <div className="l-bento">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="b-tile">
              <span className="b-icon"><Icon size={22} /></span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="l-section" aria-labelledby="review-example">
        <header className="l-head l-center">
          <h2 id="review-example">Make your next answer clearer.</h2>
          <p>Feedback points to what you said, the detail you missed, and a stronger way to structure your response.</p>
        </header>
        <div className="l-coach focused-example">
          <div className="l-card">
            <p className="l-small">Example question</p>
            <h3>How did you measure whether your model helped?</h3>
            <p className="muted">“We checked accuracy, and the model performed well.”</p>
          </div>
          <div className="l-card">
            <p className="l-small">Example feedback</p>
            <h3>Connect the metric to the goal.</h3>
            <p className="muted">Explain why you chose the metric, which baseline you compared against, and what the result meant for the project.</p>
          </div>
        </div>
        <p className="muted small focused-note">AI feedback supports practice. Scores describe a rehearsal and do not predict hiring outcomes.</p>
      </section>

      <section className="l-section l-private">
        <div className="l-private-inner">
          <I.EyeOff size={28} />
          <h2>Choose how you practise.</h2>
          <p>Local mode uses Ollama on your laptop. In the hosted version, resumes and answers are processed by AI providers, and interview history is saved in your browser. Device voices may use their own speech services.</p>
        </div>
      </section>

      <section className="l-final">
        <GhostLight size={80} />
        <h2>Your next practice round starts here.</h2>
        <a className="primary big-pill" href="#/new">Set up an interview</a>
      </section>
      <footer className="l-footer">
        <span>Rehearsly, by Siddarth Valasubramanian</span>
        <a href="#/study">Grader evaluation</a>
      </footer>
    </div>
  );
}

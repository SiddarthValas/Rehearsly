# Rehearsly

A focused GenAI interview-practice app: prepare from a resume or job description, answer one question at a time, review the feedback, and practise weak topics again.

Siddarth Valasubramanian · B.Tech CSE (Data Science), UPES

## Core experience

- Resume and job-description interviews, behavioral practice, company HR rounds, and custom subjects.
- Structured topic planning with evidence checks against supplied material.
- Adaptive difficulty and targeted follow-up questions.
- Text answers, speech transcription, question playback, and optional hands-free practice.
- Per-answer coaching: practice score, strengths, gaps, STAR structure, and suggested rewrites.
- A final review, targeted drills, PDF/Markdown export, and saved practice history.
- Company question research and practice from selected reported questions.

The main navigation is Overview, Rehearse, Questions, and Progress. Grader evaluation remains available at `#/study`, linked from the overview footer.

The application no longer includes hiring probabilities, committee votes, Mirror mode, resume heatmaps, or reacting interviewer faces. Scores describe practice performance; they are not validated predictions of hiring outcomes. Existing interview history remains readable. Old Mirror links return to the overview, and retired API endpoints are unavailable.

The existing PDF report and presentation describe the earlier, broader feature set. Update those documents before presenting this version.

## Run locally

Requires Python 3.10+, Node.js 18+, and Ollama.

```bash
ollama pull llama3.2
ollama pull nomic-embed-text
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-local.txt
cd web
npm ci
npm run build
cd ..
python run.py
```

Open http://127.0.0.1:8000. For frontend development, run `npm run dev` from `web/` in a second terminal.

## Hosted deployment

The FastAPI entrypoint is `app.py`, and the built frontend is served from `public/`. Set `GROQ_API_KEY` for the hosted provider. Optional `GEMINI_API_KEY` and `MISTRAL_API_KEY` enable fallback providers. The model client contains the supported configuration variables.

On Vercel, interviews are stored in the browser and sent back with requests. Locally, the app uses SQLite. Provider fallback can change which model grades an answer.

Local Ollama processing runs on the laptop. Hosted resumes, answers, and audio are sent to external AI services. Device speech voices may also use external services. Browser history storage does not imply that inference stays on the device.

## Architecture

- `web/src/pages/`: overview, setup, interview room, review, progress, question research, and grader evaluation.
- `web/src/lib/`: API/SSE transport, browser storage, speech, routing, and agreement statistics.
- `server/main.py`: API routes, document upload, speech, and static hosting.
- `server/engine.py`: planning, grading, adaptive follow-ups, reviews, and drills.
- `server/prompts.py`: prompts, rubrics, and structured-output schemas.
- `server/llm.py`: model providers, structured generation, streaming, speech, and search.
- `server/retrieval.py`: BM25 retrieval, plus local embedding/FAISS hybrid search when available.
- `server/research.py`: company research and reported question discovery.
- `server/study.py`: fixed answer set for grader evaluation.
- `server/documents.py`, `sections.py`, `analytics.py`, `store.py`: document parsing, focus areas, delivery heuristics, and persistence.

## Evaluation and limitations

Two graders assess answers without seeing each other's scores when both are available. Agreement measures consistency, not correctness. The `#/study` page supports blind human ratings and automatic checks over 24 developer-authored answers. This is a development benchmark, not independent validation of hiring readiness.

Planned reliability work (stricter grounding checks, schema validation, disclosed single-grader results) is kept aside for a later release. Remaining limitations include independent human validation, model grading bias, question-bank provenance, and hosted quota controls.

## Verification

```bash
cd web
npm run build
cd ..
pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
```

The regression checks use simulated model responses and isolated in-memory sessions. They do not consume provider quota or modify interview history.

## Credits

Started from the MIT-licensed GPTInterviewer prototype: https://github.com/jiatastic/GPTInterviewer. Rehearsly replaces its frontend and backend with a React/TypeScript UI and FastAPI interview engine. See `LICENSE`.

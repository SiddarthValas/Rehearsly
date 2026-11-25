"""Rehearsly API: FastAPI app serving the JSON/SSE API and the built React app."""

from __future__ import annotations

import json
import os
import platform
import time
from collections import deque
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel

from server import documents, engine, llm, mirror, research, store, study

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "public"

# "server": sessions in SQLite (local). "client": each browser keeps its own sessions and
# sends them with every request (Vercel, where functions are stateless).
STORAGE = os.getenv("REHEARSLY_STORAGE", "client" if os.getenv("VERCEL") else "server")
engine.CLIENT_STATE = STORAGE == "client"
RATE_LIMIT = int(os.getenv("REHEARSLY_RATE_LIMIT", "60" if os.getenv("VERCEL") else "0"))  # AI calls per IP per 10 min

app = FastAPI(title="Rehearsly", version="2.0.0")
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_whisper = None
_whisper_lock = threading.Lock()
_hits: dict[str, deque] = {}


@app.middleware("http")
async def _rate_limit(request: Request, call_next):
    """Best-effort per-visitor limit on AI calls, so a public deploy can't drain the API quota."""
    # Voice clips and transcriptions are cheap and frequent (one per sentence), so they don't count against the AI limit.
    if RATE_LIMIT and request.method == "POST" and request.url.path.startswith("/api/") and request.url.path not in ("/api/speech", "/api/transcribe"):
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0].strip()
        now = time.time()
        window = _hits.setdefault(ip, deque())
        while window and now - window[0] > 600:
            window.popleft()
        if len(window) >= RATE_LIMIT:
            return JSONResponse({"detail": "You're going a little fast. Take a breath and try again in a few minutes."}, status_code=429)
        window.append(now)
        if len(_hits) > 5000:
            _hits.clear()
    return await call_next(request)


@app.on_event("startup")
def _startup() -> None:
    if STORAGE == "server":
        store.init()
    if llm.PROVIDER == "ollama":
        threading.Thread(target=llm.warm, daemon=True).start()
        if os.getenv("REHEARSLY_PRELOAD_WHISPER", "1") == "1":
            threading.Thread(target=_load_whisper, daemon=True).start()


def _repo(session: dict | None = None, prior: list | None = None):
    """Request-scoped storage when the browser sends its sessions, else the server database."""
    if session is None and prior is None:
        if STORAGE == "client":
            raise HTTPException(status_code=400, detail="This deployment keeps interviews in your browser. Reload the page and try again.")
        return store.DEFAULT
    items = list(prior or [])
    if session is not None:
        items.append(session)
    return store.MemoryRepo(items)


def _sse(events) -> StreamingResponse:
    def body():
        try:
            for event in events:
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except (ValueError, KeyError) as error:
            detail = "That interview no longer exists." if isinstance(error, KeyError) else str(error)
            yield f"data: {json.dumps({'type': 'error', 'detail': detail})}\n\n"
        except llm.LLMError as error:
            yield f"data: {json.dumps({'type': 'error', 'detail': str(error)})}\n\n"
        except Exception as error:  # pragma: no cover - surface anything unexpected to the UI
            yield f"data: {json.dumps({'type': 'error', 'detail': f'Unexpected error: {error}'})}\n\n"

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _not_found():
    raise HTTPException(status_code=404, detail="That interview no longer exists.")


# --------------------------------------------------------------------------- health

@app.get("/api/health")
def health():
    status = llm.status()
    status["whisper"] = llm.PROVIDER == "groq" or _whisper is not None
    status["serverTts"] = platform.system() == "Darwin" and not os.getenv("VERCEL")
    status["storage"] = STORAGE
    status["search"] = llm.can_search()
    status["tts"] = "groq" if llm.GROQ_KEY else ("mac" if platform.system() == "Darwin" and not os.getenv("VERCEL") else None)
    status["voices"] = llm.TTS_VOICES if llm.GROQ_KEY else []
    return status


@app.get("/api/providers")
def providers():
    """Is each AI provider (Groq and the backups) reachable with the configured key?"""
    return {"providers": llm.provider_check()}


# --------------------------------------------------------------------------- sessions

@app.post("/api/sessions")
def open_session(
    mode: str = Form(...),
    role: str = Form(""),
    jd: str = Form(""),
    persona: str = Form("professional"),
    length: str = Form("standard"),
    difficulty: int = Form(2),
    focus: str = Form(""),
    specialty: str = Form(""),
    customPersona: str = Form(""),
    model: str = Form(""),
    areas: str = Form(""),
    company: str = Form(""),
    questions: str = Form(""),
    prior: str = Form(""),
    resume: UploadFile | None = File(None),
):
    text = ""
    if resume is not None and resume.filename:
        try:
            text = documents.extract_text(resume.filename, resume.file.read())
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    payload = {
        "mode": mode, "role": role, "jd": jd, "persona": persona, "length": length, "difficulty": difficulty,
        "focus": focus, "specialty": specialty, "customPersona": customPersona, "model": model, "areas": areas,
        "company": company, "questions": questions,
    }
    repo = None
    if STORAGE == "client" or prior:
        try:
            earlier = json.loads(prior) if prior else []
        except json.JSONDecodeError:
            earlier = []
        repo = store.MemoryRepo(earlier if isinstance(earlier, list) else [])
    if llm.PROVIDER == "groq":
        payload["model"] = ""
    return _sse(engine.create(payload, text, repo))


@app.get("/api/sessions")
def list_sessions():
    if STORAGE == "client":
        return {"sessions": [], "trend": [], "byKind": {}, "stats": {"count": 0, "completed": 0, "best": None, "average": None, "answers": 0}}
    return engine.history()


@app.get("/api/sessions/{session_id}")
def read_session(session_id: str):
    try:
        return engine.public(engine.get(session_id))
    except KeyError:
        _not_found()


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: str):
    if not store.delete(session_id):
        _not_found()
    return {"ok": True}


class AnswerIn(BaseModel):
    content: str
    duration: float | None = None
    via: str = "text"
    session: dict | None = None


class StateIn(BaseModel):
    session: dict | None = None
    prior: list | None = None


@app.post("/api/sessions/{session_id}/answer")
def answer(session_id: str, body: AnswerIn):
    repo = _repo(body.session)
    try:
        engine.get(session_id, repo)
    except KeyError:
        _not_found()
    return _sse(engine.reply(session_id, body.content, body.duration, body.via, repo))


@app.post("/api/sessions/{session_id}/hint")
def hint(session_id: str, body: StateIn | None = Body(None)):
    try:
        return engine.hint(session_id, _repo(body.session if body else None))
    except KeyError:
        _not_found()


class BankIn(BaseModel):
    company: str
    role: str = ""
    refresh: bool = False


@app.post("/api/research/questions")
def question_bank(body: BankIn):
    """Search the web for questions previously asked at a company. Streams progress."""
    return _sse(research.question_bank(body.company, body.role, body.refresh))


@app.post("/api/sessions/{session_id}/drill")
def drill(session_id: str, body: StateIn | None = Body(None)):
    try:
        return engine.drill(session_id, _repo(body.session if body else None, body.prior if body else None))
    except KeyError:
        _not_found()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except llm.LLMError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/sessions/{session_id}/end")
def end(session_id: str, body: StateIn | None = Body(None)):
    try:
        return engine.end(session_id, _repo(body.session if body else None))
    except KeyError:
        _not_found()


@app.post("/api/sessions/{session_id}/review")
def review(session_id: str, refresh: bool = False, body: StateIn | None = Body(None)):
    try:
        return engine.review(session_id, refresh, _repo(body.session if body else None))
    except KeyError:
        _not_found()
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except llm.LLMError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


# --------------------------------------------------------------------------- grading study
class StudyGradeIn(BaseModel):
    ids: list[str]


@app.get("/api/study/items")
def study_items():
    """The fixed answer set people rate, with the rubric the AI graders use."""
    return study.items()


@app.post("/api/study/grade")
def study_grade(body: StudyGradeIn):
    """Grade study answers with the same two graders a live interview uses."""
    try:
        return study.grade(body.ids)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


# --------------------------------------------------------------------------- mirror mode

class MirrorStartIn(BaseModel):
    role: str = ""
    persona: str = ""


class MirrorAskIn(BaseModel):
    sealed: str
    question: str
    history: list = []


class MirrorRevealIn(BaseModel):
    sealed: str
    turns: list = []


@app.post("/api/mirror/start")
def mirror_start(body: MirrorStartIn):
    try:
        return mirror.start(body.role, body.persona)
    except llm.LLMError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@app.post("/api/mirror/self")
def mirror_self(
    name: str = Form(""),
    role: str = Form(""),
    voice: str = Form(""),
    resumeText: str = Form(""),
    resume: UploadFile | None = File(None),
):
    """Interview yourself: your AI self answers from your resume."""
    text = resumeText
    if resume is not None and resume.filename:
        try:
            text = documents.extract_text(resume.filename, resume.file.read())
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        return mirror.start_self(name, role, text, voice)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/mirror/answer")
def mirror_answer(body: MirrorAskIn):
    return _sse(mirror.answer(body.sealed, body.history, body.question))


@app.post("/api/mirror/reveal")
def mirror_reveal(body: MirrorRevealIn):
    try:
        return mirror.reveal(body.sealed, body.turns)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


# --------------------------------------------------------------------------- voice

def _load_whisper():
    global _whisper
    with _whisper_lock:
        if _whisper is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError:
                return None
            _whisper = WhisperModel(os.getenv("WHISPER_MODEL", "base.en"), device="cpu", compute_type="int8")
    return _whisper


@app.post("/api/transcribe")
def transcribe(audio: UploadFile = File(...)):
    if llm.PROVIDER == "groq":
        data = audio.file.read()
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="That recording is too long. Keep answers under a few minutes.")
        try:
            text, duration = llm.transcribe(data, audio.filename or "answer.wav")
        except llm.LLMError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        return {"text": text, "duration": round(duration, 2)}
    model = _load_whisper()
    if model is None:
        raise HTTPException(status_code=501, detail="Install faster-whisper for voice answers: pip install faster-whisper")
    suffix = Path(audio.filename or "answer.wav").suffix or ".wav"
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        Path(path).write_bytes(audio.file.read())
        segments, info = model.transcribe(path, beam_size=1, vad_filter=True, language="en")
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"Could not transcribe that recording: {error}") from error
    finally:
        Path(path).unlink(missing_ok=True)
    return {"text": text, "duration": round(getattr(info, "duration", 0) or 0, 2)}


class SpeechIn(BaseModel):
    text: str
    voice: str = ""
    style: str = ""


_DIRECTIONS = {"coach": "cheerful", "professional": "professionally", "bar_raiser": "authoritatively"}


@app.post("/api/speech")
def speech(body: SpeechIn):
    """Natural interviewer voice (Groq Orpheus); macOS `say` locally as a fallback.
    The browser's own speechSynthesis is the last resort, handled in the UI."""
    if llm.GROQ_KEY and body.voice != "mac":
        text = " ".join(body.text.split())
        if not text:
            raise HTTPException(status_code=400, detail="Nothing to read.")
        try:
            audio = llm.speak(text[:200], body.voice or "hannah", _DIRECTIONS.get(body.style, ""))
        except llm.LLMError as error:
            raise HTTPException(status_code=getattr(error, "status", None) or 502, detail=str(error)) from error
        return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})
    if platform.system() != "Darwin" or os.getenv("VERCEL"):
        raise HTTPException(status_code=501, detail="Server speech is only available on macOS.")
    text = " ".join(body.text.split())[:1200]
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to read.")
    stem = Path(tempfile.gettempdir()) / f"rehearsly-{uuid.uuid4().hex}"
    aiff, wav = stem.with_suffix(".aiff"), stem.with_suffix(".wav")
    command = ["/usr/bin/say", "-o", str(aiff)] + (["-v", body.voice] if body.voice else []) + [text]
    try:
        subprocess.run(command, check=True, capture_output=True)
        subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16", str(aiff), str(wav)], check=True, capture_output=True)
        audio = wav.read_bytes()
    except subprocess.CalledProcessError as error:
        raise HTTPException(status_code=500, detail="Speech synthesis failed.") from error
    finally:
        aiff.unlink(missing_ok=True)
        wav.unlink(missing_ok=True)
    return Response(content=audio, media_type="audio/wav")


# --------------------------------------------------------------------------- static app

@app.get("/{full_path:path}")
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found.")
    target = (DIST / full_path).resolve()
    if full_path and str(target).startswith(str(DIST.resolve())) and target.is_file():
        headers = {"Cache-Control": "public, max-age=31536000, immutable"} if "/assets/" in f"/{full_path}" else {}
        return FileResponse(target, headers=headers)
    page = DIST / "index.html"
    if page.exists():
        return FileResponse(page, headers={"Cache-Control": "no-cache"})
    raise HTTPException(status_code=503, detail="The interface isn't built yet. Run: cd web && npm install && npm run build")


# Vercel looks for `app`; keep the name explicit for readers.
__all__ = ["app"]

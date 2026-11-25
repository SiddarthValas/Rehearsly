"""Rehearsly interview engine.

Pipeline per session:
  1. Extract text (resume / JD) -> structured profile + JD skill gap map
  2. Plan N grounded topics (every topic must cite evidence that exists in the source)
  3. Loop: assess answer (structured JSON) -> adapt difficulty -> follow-up or next topic -> stream question
  4. Review: deterministic score from per-answer grades + LLM narrative and competency map
"""

from __future__ import annotations

import hashlib
import json
import math
import random
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Iterator

from server import analytics, llm, prompts, research, sections, store
from server.retrieval import Index, tokens

MODES = ("resume", "technical", "behavioral", "custom", "hr", "bank")

BANK_KINDS = {
    "Behavioral & HR": "behavioral", "Coding & DSA": "fundamentals", "SQL & databases": "fundamentals",
    "Machine learning": "fundamentals", "Statistics & probability": "fundamentals", "System design": "scenario",
    "Product & case": "scenario", "Projects & resume": "project", "Company & role": "company", "Aptitude & puzzles": "fundamentals",
}
LENGTHS = {"short": 4, "medium": 6, "long": 8, "quick": 4, "standard": 6, "deep": 8}
LENGTH_NAMES = {"quick": "short", "standard": "medium", "deep": "long"}
MAX_SOURCE = 9000

_locks: dict[str, threading.Lock] = {}
_indexes: dict[str, Index] = {}
_guard = threading.Lock()
_pool = ThreadPoolExecutor(max_workers=4)


# ----------------------------------------------------------------------------- helpers

def _lock(session_id: str) -> threading.Lock:
    with _guard:
        return _locks.setdefault(session_id, threading.Lock())


def _index(session: dict) -> Index:
    with _guard:
        index = _indexes.get(session["id"])
    if index is None:
        index = Index(session.get("source") or session.get("title", ""))
        with _guard:
            if len(_indexes) > 200:
                _indexes.clear()
            _indexes[session["id"]] = index
    return index


def _clip(text: str, limit: int = MAX_SOURCE) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit]


def _brace_safe(value: str, limit: int = 400) -> str:
    return " ".join(str(value).split())[:limit]


def _signature(text: str) -> set[str]:
    return {word for word in tokens(text) if len(word) > 2}


def _similar(a: str, b: str) -> float:
    sa, sb = _signature(a), _signature(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


_IMPERATIVE = re.compile(r"^(please\s+)?(walk|tell|describe|explain|design|implement|write|give|share|talk|show|name|list|compare|outline|sketch|derive|estimate|discuss)\b", re.I)


_STOP = {"the", "and", "with", "for", "that", "this", "from", "using", "built", "used", "your", "what", "how", "you", "did"}


def _covered(extra: dict, kept: dict) -> bool:
    """A filler topic whose subject an existing topic already covers (e.g. 'churn model' after the IBM churn line)."""
    words = {w for w in re.findall(r"[a-z0-9]+", (extra["title"] + " " + extra["evidence"]).lower()) if len(w) > 3 and w not in _STOP}
    if not words:
        return False
    seen = set(re.findall(r"[a-z0-9]+", (kept["title"] + " " + kept["evidence"] + " " + kept["planned"]).lower()))
    return len(words & seen) / len(words) >= 0.5


def _punctuate(question: str) -> str:
    """A question ends with '?', a direct instruction ("Describe...", "Walk me through...") ends with '.'."""
    question = question.strip().rstrip(" .?!")
    return question + ("." if _IMPERATIVE.match(question) else "?")


def _fingerprint(text: str) -> str:
    normalised = " ".join(text.lower().split())[:4000]
    return hashlib.sha1(normalised.encode()).hexdigest()[:16]


def _previous_questions(fingerprint: str, limit_sessions: int = 4, repo=None) -> list[str]:
    """Questions asked in earlier rehearsals on the same material, newest first."""
    questions: list[str] = []
    seen = 0
    for old in (repo or store.DEFAULT).all_sessions():
        if old.get("fingerprint") != fingerprint:
            continue
        seen += 1
        for message in old.get("messages", []):
            if message.get("role") == "interviewer" and message.get("kind") in ("question", "followup"):
                questions.append(message["content"])
        for topic in old.get("topics", []):
            questions.append(topic.get("planned", ""))
        if seen >= limit_sessions:
            break
    unique, keys = [], set()
    for question in questions:
        key = " ".join(sorted(_signature(question)))
        if question and key not in keys:
            keys.add(key)
            unique.append(question)
    return unique


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


def _is_repeat(question: str, previous: list[str]) -> bool:
    """Lexical check first (cheap), then semantic check with embeddings when available."""
    if not previous:
        return False
    if any(_similar(question, earlier) > 0.5 for earlier in previous):
        return True
    vectors = llm.embed([question] + previous[-10:])
    if not vectors:
        return False
    head, rest = vectors[0], vectors[1:]
    return any(_cosine(head, other) > 0.9 for other in rest)


def _in_source(phrase: str, source: str) -> bool:
    phrase = " ".join(phrase.lower().split()).strip(" .\"'")
    return bool(phrase) and phrase in " ".join(source.lower().split())


def _ground(topic: dict, source: str) -> str:
    """Return evidence that really exists in the source, or the closest source line."""
    evidence = topic.get("evidence", "").strip().strip("\"'")
    if evidence and _in_source(evidence, source):
        return evidence[:200]
    wanted = _signature(f"{topic.get('title', '')} {evidence}")
    best, best_score = "", 0
    for line in re.split(r"\n|(?<=[.!?])\s+", source):
        line = line.strip(" •-")
        if len(line) < 4:
            continue
        score = len(wanted & _signature(line))
        if score > best_score:
            best, best_score = line, score
    return best[:200] if best_score else ""


def _new_topic(index: int, title: str, kind: str, evidence: str, question: str) -> dict:
    return {
        "id": f"t{index + 1}",
        "title": title.strip()[:60],
        "kind": kind if kind in prompts.TOPIC_KINDS else "experience",
        "evidence": evidence[:200],
        "planned": question.strip()[:400],
        "status": "pending",
        "score": None,
        "followups": 0,
    }


def _fallback_topics(source: str, profile: dict, count: int, mode: str) -> list[dict]:
    seeds: list[tuple[str, str]] = []
    for key, kind in (("projects", "project"), ("roles", "experience"), ("skills", "fundamentals"), ("claims", "behavioral")):
        for item in profile.get(key, []):
            seeds.append((item, kind))
    kind_default = "behavioral" if mode == "behavioral" else "fundamentals"
    # Comma / "and" separated skill lists ("Python, FastAPI, Redis caching and CI/CD")
    # (Skipped for a parsed resume: splitting "IBM, Data Science Intern" on commas gives "IBM" as a skill.)
    for part in [] if (mode == "resume" and seeds) else re.split(r",|\band\b|\n|;|•|:", source):
        part = part.strip(" .-")
        if 2 <= len(part) <= 40 and not re.fullmatch(r"(subject|focus|we need|experience|requirements?)", part, re.I):
            seeds.append((part, kind_default))
    for line in [] if (mode == "resume" and seeds) else re.split(r"\n|;|•", source):
        line = line.strip(" .-:")
        if 12 <= len(line) <= 160:
            seeds.append((line, kind_default))
    topics, seen = [], set()
    for seed, kind in seeds:
        title = " ".join(seed.split()[:4]).strip(",.:")
        key = title.lower()
        if key in seen or len(title) < 3:
            continue
        seen.add(key)
        short = re.split(r"\s+[–—-]\s+|:\s+|\s*\(", seed)[0].strip()[:120] or seed[:120]
        short = re.sub(r"^(we need|we want|must have|nice to have|requirements?|skills?)\s*:?\s+", "", short, flags=re.I) or short
        if short.lower().strip(" :") in ("skills", "education", "experience", "projects", "summary", "contact", "certifications", "achievements"):
            continue  # a section heading, not a topic
        first = short.split()
        if kind == "project" and len(first) > 1 and first[0][1:].islower() and first[1][:1].islower():
            short = short[:1].lower() + short[1:]  # "Walk me through customer churn model", not "...Customer churn model"
        if kind == "behavioral":
            if len(seed.split()) <= 4:
                options = [
                    f"Tell me about a time you demonstrated {seed.lower()}. What did you do, and what happened?",
                    f"Describe a situation where {seed.lower()} really mattered. What was your role and the outcome?",
                    f"Give me a specific example of {seed.lower()} from your own experience. What would you do differently?",
                ]
            else:
                options = [f"Tell me about a time that relates to this: {short}. What did you do, and what happened?"]
        elif kind == "experience":
            options = [
                f"Tell me about your time as {short}. What did you own, and what result are you proudest of?",
                f"What was the hardest problem you faced as {short}, and how did you solve it?",
            ]
        elif kind == "project" or len(short.split()) > 3:  # a resume line or project, not a single skill
            options = [
                f"Walk me through {short}. What was your part, and what was hardest?",
                f"What problem was {short} solving, and how did you know it worked?",
                f"If you rebuilt {short} today, what would you change, and why?",
            ]
        else:
            options = [
                f"How have you used {short} in practice, and what would you do differently now?",
                f"Explain {short} as you would to a new teammate, then tell me where you've applied it.",
                f"What's a common mistake people make with {short}, and how do you avoid it?",
                f"Describe a problem you solved with {short}. What made it tricky?",
            ]
        question = random.choice(options)
        topics.append(_new_topic(len(topics), title, kind, seed, question))
        if len(topics) >= count:
            break
    return topics


def _profile_text(profile: dict) -> str:
    lines = []
    for key in ("roles", "projects", "skills", "metrics", "claims"):
        values = profile.get(key) or []
        if values:
            lines.append(f"{key}: " + "; ".join(values))
    return "\n".join(lines)


def _clean_list(values, limit: int, source: str | None = None) -> list[str]:
    out, seen = [], set()
    for value in values or []:
        value = " ".join(str(value).split()).strip(" -•,.")
        if not value or value.lower() in {"none", "n/a", "na", "null"} or value.lower() in seen:
            continue
        if source is not None and not (_signature(value) & _signature(source)):
            continue  # drop hallucinated items with no overlap with the source
        seen.add(value.lower())
        out.append(value[:160])
        if len(out) >= limit:
            break
    return out


def _heuristic_profile(text: str) -> dict:
    profile = {"name": "", "headline": "", "roles": [], "projects": [], "skills": [], "metrics": [], "claims": []}
    for line in text.splitlines():
        item = " ".join(line.split()).strip(" •-")
        lowered = item.lower()
        if len(item) < 3:
            continue
        if lowered.startswith(("skills", "technical skills", "tools", "languages")) and ":" in item:
            profile["skills"].extend(part.strip() for part in re.split(r",|\|", item.split(":", 1)[1]) if part.strip())
        elif re.search(r"\b(built|designed|developed|created|implemented|shipped)\b", lowered):
            profile["projects"].append(item)
        elif re.search(r"\b(led|owned|mentored|managed|spearheaded)\b", lowered):
            profile["claims"].append(item)
        if re.search(r"\d+\s*(%|x|users|ms|k\b|percent)", lowered):
            profile["metrics"].append(item)
        if re.search(r"\b(intern|engineer|analyst|developer|scientist|manager)\b", lowered) and len(item.split()) <= 10:
            profile["roles"].append(item)
    for key, limit in (("roles", 5), ("projects", 6), ("skills", 14), ("metrics", 6), ("claims", 5)):
        profile[key] = _clean_list(profile[key], limit)
    return profile


def _skill_present(skill: str, text: str) -> bool:
    lowered = " ".join(text.lower().split())
    skill_l = skill.lower().strip()
    if skill_l and skill_l in lowered:
        return True
    words = [word for word in tokens(skill_l) if len(word) > 2]
    return bool(words) and all(word in lowered for word in words)


def _transcript(messages: list[dict], last: int | None = None) -> str:
    items = messages[-last:] if last else messages
    lines = []
    for message in items:
        speaker = "Interviewer" if message["role"] == "interviewer" else "Candidate"
        lines.append(f"{speaker}: {message['content']}")
    return "\n".join(lines)


def _first_question(text: str) -> str:
    text = text.strip().strip('"').strip()
    text = re.sub(r"^\s*(interviewer|ai|assistant)\s*:\s*", "", text, flags=re.I)
    text = re.sub(r"\s+", " ", text)
    mark = text.find("?")
    return (text[: mark + 1] if mark != -1 else text).strip()[:600]


def _keeps_evidence(question: str, topic: dict) -> bool:
    words = [word for word in _signature(f"{topic['evidence']} {topic['title']}") if len(word) > 3]
    lowered = question.lower()
    return not words or any(word in lowered for word in words)


def _message(role: str, content: str, kind: str, topic: int | None = None, difficulty: int | None = None) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "role": role,
        "content": content,
        "kind": kind,
        "topic": topic,
        "difficulty": difficulty,
        "ts": time.time(),
    }


def _readiness(score: float) -> str:
    if score >= 80:
        return "Strong practice performance"
    if score >= 65:
        return "Good foundation; keep practising"
    if score >= 45:
        return "Building momentum"
    return "Early days"


def _scoring(session: dict) -> dict:
    topics = session["topics"]
    answered = [topic for topic in topics if topic["status"] != "pending"]
    scores = [topic["score"] or 0 for topic in answered]
    average = sum(scores) / len(scores) if scores else 0.0
    return {
        "score": round(average * 10),
        "average": round(average, 2),
        "answered": len(answered),
        "total": len(topics),
        "provisional": len(answered) < len(topics),
    }


# ----------------------------------------------------------------------------- public views

CLIENT_STATE = False  # hosted mode: the browser stores sessions, so return the full state


def public(session: dict) -> dict:
    view = {key: value for key, value in session.items()
            if key not in ("hireTrail", "committee", "heatmap") and (CLIENT_STATE or key != "source")}
    view.update(_scoring(session))
    view["covered"] = sum(1 for topic in session["topics"] if topic["status"] == "covered")
    view["exchanges"] = sum(1 for message in session["messages"] if message["role"] == "candidate")
    return view


def summary(session: dict) -> dict:
    scoring = _scoring(session)
    review = session.get("review") or {}
    return {
        "id": session["id"],
        "mode": session["mode"],
        "title": session["title"],
        "role": session.get("role", ""),
        "persona": session["config"].get("persona"),
        "drill": bool(session.get("drillOf")),
        "createdAt": session["createdAt"],
        "updatedAt": session.get("updatedAt", session["createdAt"]),
        "complete": session["complete"],
        "reviewed": bool(review),
        "score": review.get("score", scoring["score"]) if scoring["answered"] else None,
        "answered": scoring["answered"],
        "total": scoring["total"],
        "topics": [{"title": topic["title"], "score": topic["score"], "status": topic["status"]} for topic in session["topics"]],
    }


def get(session_id: str, repo=None) -> dict:
    session = (repo or store.DEFAULT).load(session_id)
    if session is None:
        raise KeyError(session_id)
    return session


def history(repo=None) -> dict:
    repo = repo or store.DEFAULT
    sessions = [summary(session) for session in repo.all_sessions()]
    scored = [item for item in sessions if item["score"] is not None and item["answered"]]
    trend = [{"id": item["id"], "score": item["score"], "at": item["createdAt"], "title": item["title"]} for item in reversed(scored)]
    topic_scores: dict[str, list[int]] = {}
    for session in repo.all_sessions():
        for topic in session["topics"]:
            if topic["score"] is not None:
                topic_scores.setdefault(topic["kind"], []).append(topic["score"])
    by_kind = {kind: round(sum(values) / len(values), 1) for kind, values in topic_scores.items()}
    best = max((item["score"] for item in scored), default=None)
    return {
        "sessions": sessions,
        "trend": trend,
        "byKind": by_kind,
        "stats": {
            "count": len(sessions),
            "completed": sum(1 for item in sessions if item["complete"]),
            "best": best,
            "average": round(sum(item["score"] for item in scored) / len(scored)) if scored else None,
            "answers": sum(item["answered"] for item in sessions),
        },
    }


# ----------------------------------------------------------------------------- creation

def create(payload: dict, document_text: str = "", repo=None) -> Iterator[dict]:
    """Build a session. Yields progress events, ending with {"type": "session"}."""
    mode = payload.get("mode", "")
    if mode not in MODES:
        raise ValueError("Choose an interview type.")
    model = payload.get("model") or llm.DEFAULT_MODEL
    persona_key = payload.get("persona") if payload.get("persona") in prompts.PERSONAS else "professional"
    length_key = LENGTH_NAMES.get(payload.get("length", ""), payload.get("length", "medium"))
    count = LENGTHS.get(length_key, 6)
    raw_areas = [item.strip() for item in str(payload.get("areas", "")).split(",") if item.strip()]
    try:
        difficulty = max(1, min(5, int(payload.get("difficulty") or 2)))
    except (TypeError, ValueError):
        difficulty = 2
    role = _brace_safe(payload.get("role", ""), 80)
    jd = _clip(payload.get("jd", ""), 6000)
    focus = _brace_safe(payload.get("focus", ""), 200)
    style = prompts.PERSONAS[persona_key]["style"]
    company = _brace_safe(payload.get("company", ""), 80)
    if company and mode not in ("hr",):
        style += f" You are interviewing the candidate for a position at {company}."
    preset_topics: list[dict] = []
    profile = {"name": "", "headline": "", "roles": [], "projects": [], "skills": [], "metrics": [], "claims": []}
    gaps = None

    if mode == "resume":
        source = _clip(document_text)
        if len(source) < 40:
            raise ValueError("Upload your resume to start a resume interview.")
        title = role or "Resume deep dive"
        areas = [area for area in raw_areas if area in sections.AREAS]
        focused, found_areas = sections.focus(source, areas)
        area_text = ", ".join(sections.AREA_LABELS[a] for a in areas)
        yield {"type": "stage", "key": "read", "label": f"Read {len(source.split())} words from your resume"}
        if areas:
            label = (
                f"Focusing on {', '.join(sections.AREA_LABELS[a] for a in found_areas)}"
                if found_areas
                else f"Couldn't find those headings, so asking the model to focus on {area_text}"
            )
            yield {"type": "stage", "key": "focus", "label": label}
        yield {"type": "stage", "key": "profile", "label": "Extracting roles, projects, skills and claims", "pending": True}
        profile_job = _pool.submit(
            llm.chat,
            [{"role": "user", "content": prompts.profile_prompt(source, role)}],
            model=model, temperature=0.1, max_tokens=700, schema=prompts.PROFILE_SCHEMA,
        )
        skills_job = None
        if len(jd.split()) >= 5:
            skills_job = _pool.submit(
                llm.chat,
                [{"role": "user", "content": prompts.skills_prompt(jd)}],
                model=model, temperature=0.1, max_tokens=300, schema=prompts.SKILLS_SCHEMA,
            )
        try:
            raw = profile_job.result()
            profile = {
                "name": _brace_safe(raw.get("name", ""), 60) if _in_source(str(raw.get("name", "")), source) else "",
                "headline": _brace_safe(raw.get("headline", ""), 140),
                "roles": _clean_list(raw.get("roles"), 5, source),
                "projects": _clean_list(raw.get("projects"), 6, source),
                "skills": _clean_list(raw.get("skills"), 14, source),
                "metrics": _clean_list(raw.get("metrics"), 6, source),
                "claims": _clean_list(raw.get("claims"), 5, source),
            }
        except llm.LLMError:
            raise
        except Exception:
            profile = {}
        if not any(profile.get(key) for key in ("roles", "projects", "skills")):
            profile = _heuristic_profile(source)
        yield {"type": "profile", "profile": profile}
        if skills_job is not None:
            yield {"type": "stage", "key": "gaps", "label": "Matching your resume against the job description", "pending": True}
            try:
                wanted = _clean_list(skills_job.result().get("skills"), 12, jd)
            except Exception:
                wanted = []
            matched = [skill for skill in wanted if _skill_present(skill, source)]
            missing = [skill for skill in wanted if skill not in matched]
            gaps = {
                "matched": matched,
                "missing": missing,
                "match": round(100 * len(matched) / len(wanted)) if wanted else None,
            }
            yield {"type": "gaps", "gaps": gaps}
        plan_source = focused
        plan_kwargs = dict(
            role=role, profile=_profile_text(profile) if not areas else "",
            gaps=", ".join(gaps["missing"][:4]) if gaps and gaps["missing"] and not areas else "", focus=focus,
            areas=area_text, company=company,
        )
        greeting = {
            "coach": f"Hi! Thanks for joining. I've gone through your resume{' for the ' + role + ' role' if role else ''}. To start, tell me a little about yourself.",
            "professional": f"Hello. I've read your resume{' for the ' + role + ' role' if role else ''}. Please start with a short introduction.",
            "bar_raiser": "Let's begin. Give me a sixty-second introduction, focused on what you've actually built.",
        }[persona_key]
        # Ground against the resume plus the JD, so gap topics can cite the JD.
        if jd and not areas:
            plan_source = source + "\n" + jd
        fingerprint = _fingerprint(source)
    elif mode in ("technical", "behavioral"):
        if len(jd.split()) < 4:
            raise ValueError("Paste a job description, or at least a few skills or values, before starting.")
        source = jd
        plan_source = source
        first_line = next((line for line in jd.splitlines() if line.strip()), jd)
        title = role or _brace_safe(first_line, 70)
        yield {"type": "stage", "key": "read", "label": f"Read {len(jd.split())} words of the brief"}
        options = prompts.TECH_FOCUS if mode == "technical" else prompts.BEHAVIORAL_FOCUS
        areas = [area for area in raw_areas if area in options]
        area_text = ", ".join(options[a] for a in areas)
        if areas:
            yield {"type": "stage", "key": "focus", "label": f"Focusing on {area_text}"}
        plan_kwargs = dict(role=role, focus=focus, areas=area_text, company=company)
        fingerprint = _fingerprint(jd)
        if mode == "technical":
            greeting = {
                "coach": "Hi, great to meet you! We'll talk through the skills in this role. Start by introducing yourself.",
                "professional": "Hello. I'll ask about the work described in this role. Please introduce yourself briefly.",
                "bar_raiser": "Let's get into it. Introduce yourself in under a minute, then we'll go technical.",
            }[persona_key]
        else:
            greeting = {
                "coach": "Hi! This one's about how you work with people. No trick questions. Tell me a bit about yourself first.",
                "professional": "Hello. This conversation is about how you work with others. Please start with a short introduction.",
                "bar_raiser": "This is a behavioral round. I'll want real stories with real outcomes. Introduce yourself.",
            }[persona_key]

    elif mode == "hr":
        if len(company) < 2:
            raise ValueError("Enter the company you're interviewing with.")
        live = llm.can_search()
        yield {"type": "stage", "key": "research", "label": f"Researching {company} on the web: values, culture, recent news" if live else f"Recalling what's known about {company} (live search is off)", "pending": True}
        brief = research.company_brief(company, role)
        yield {"type": "brief", "brief": brief}
        if live:
            yield {"type": "stage", "key": "research-done", "label": f"Read {len(brief['sources'])} sources about {company}"}
        source = research.brief_text(brief)
        if document_text:
            source += "\nCandidate resume:\n" + _clip(document_text, 4000)
        plan_source = source
        title = f"HR round at {company}"
        style = f"You are an HR recruiter at {company}. " + style
        areas = []
        plan_kwargs = dict(role=role, focus=focus, company=company)
        fingerprint = _fingerprint("hr|" + company.lower())
        greeting = {
            "coach": f"Hi, and thanks for your interest in {company}! To start, tell me a little about yourself and what draws you to us.",
            "professional": f"Hello, and thank you for applying to {company}. Please start by telling me about yourself and why you're interested in us.",
            "bar_raiser": f"Let's begin. Tell me about yourself, and be specific about why {company} and not a competitor.",
        }[persona_key]

    elif mode == "bank":
        try:
            picked = json.loads(payload.get("questions") or "[]")
        except json.JSONDecodeError:
            picked = []
        for item in picked if isinstance(picked, list) else []:
            question = " ".join(str((item or {}).get("question", "")).split())[:400]
            if len(question) < 8:
                continue
            core = re.sub(
                r"^(can you |could you |please )?(tell me about a time (when |that |you )?|tell me about |what is the difference between |"
                r"what are the differences between |explain (the )?|describe (a time (when |you )?)?|how would you |how do you |how did you |"
                r"walk me through |what (is|are) |why (do|did|would) you |give an example of )",
                "", question, flags=re.I,
            )
            title = " ".join(re.sub(r"[^\w\s/&+-]", "", core).split()[:5]) or " ".join(question.split()[:5])
            title = title[:1].upper() + title[1:]
            imperative = re.match(r"(walk|tell|describe|explain|design|implement|write|give|share|talk|show|name|list|compare)\b", question, re.I)
            asked = question if question.endswith(("?", ".")) and (question.endswith("?") or imperative) else question.rstrip(" .") + ("." if imperative else "?")
            topic = _new_topic(len(preset_topics), title, "fundamentals", question, asked)
            topic["subject"] = str((item or {}).get("subject", ""))[:40]
            topic["kind"] = BANK_KINDS.get(topic["subject"], "fundamentals")
            topic["real"] = True
            preset_topics.append(topic)
            if len(preset_topics) >= 12:
                break
        if not preset_topics:
            raise ValueError("Pick at least one question to practise.")
        source = "\n".join(t["planned"] for t in preset_topics)
        plan_source = source
        where = company or "this company"
        title = f"Past questions at {where}" + (f", {role}" if role else "")
        yield {"type": "stage", "key": "read", "label": f"Loaded {len(preset_topics)} real questions from {where}"}
        areas = []
        plan_kwargs = {}
        fingerprint = _fingerprint("bank|" + where.lower())
        greeting = f"Let's practise questions candidates have actually been asked at {where}. A quick introduction first, then we'll begin."

    else:
        specialty = _brace_safe(payload.get("specialty", "") or "a general interview", 120)
        custom = _brace_safe(payload.get("customPersona", ""), 200)
        if custom:
            style = f"You are {custom}. Stay in that character."
        source = f"Subject: {specialty}\nFocus: {focus or 'core concepts and practical scenarios'}\n{jd}"
        plan_source = source
        title = specialty[:1].upper() + specialty[1:]
        yield {"type": "stage", "key": "read", "label": f"Setting up a {specialty} interview"}
        areas = []
        plan_kwargs = dict(focus=focus)
        fingerprint = _fingerprint(source)
        greeting = f"Hello. Today we'll talk about {specialty}. Start by telling me about your experience with it."

    if preset_topics:
        topics = preset_topics
    else:
        previous = _previous_questions(fingerprint, repo=repo)
        if previous:
            yield {"type": "stage", "key": "fresh", "label": f"Avoiding {len(previous)} questions from your earlier rehearsals"}
        plan = prompts.plan_prompt(mode, plan_source, count, avoid=previous, **plan_kwargs)
        yield {"type": "stage", "key": "plan", "label": f"Planning {count} grounded topics", "pending": True}
        topics: list[dict] = []
        stale: list[dict] = []  # grounded but too close to earlier rehearsals; used only if we run short
        try:
            raw_plan = llm.chat(
                [{"role": "user", "content": plan}], model=model, temperature=0.35, max_tokens=1400, schema=prompts.PLAN_SCHEMA
            )
            for item in raw_plan.get("topics", []) if isinstance(raw_plan, dict) else []:
                if not isinstance(item, dict) or not item.get("title") or not item.get("question"):
                    continue
                candidate = _new_topic(len(topics), str(item["title"]), str(item.get("kind", "")), str(item.get("evidence", "")), str(item["question"]))
                if mode != "custom":
                    candidate["evidence"] = _ground(candidate, plan_source)
                    if not candidate["evidence"]:
                        continue  # ungrounded topic: drop it rather than ask about something they never said
                else:
                    candidate["evidence"] = candidate["evidence"] or candidate["title"]
                if mode == "behavioral":
                    candidate["kind"] = "behavioral"
                if any(
                    _similar(candidate["title"] + candidate["planned"], kept["title"] + kept["planned"]) > 0.5
                    or _similar(candidate["planned"], kept["planned"]) > 0.55
                    or _similar(candidate["title"], kept["title"]) > 0.6
                    for kept in topics
                ):
                    continue
                if any(candidate["evidence"].lower() == kept["evidence"].lower() for kept in topics):
                    continue  # two topics about the same line of the resume
                if previous and any(_similar(candidate["planned"], old) > 0.5 for old in previous):
                    stale.append(candidate)
                    continue
                candidate["planned"] = _punctuate(candidate["planned"])
                topics.append(candidate)
                if len(topics) >= count:
                    break
        except llm.LLMError:
            raise
        # Fill up: fresh candidates first, then ones close to earlier rehearsals, so practising
        # the same material again never fails, it just prefers new angles.
        candidates = stale + _fallback_topics(plan_source, profile if not areas else {}, count * 3, mode)
        for allow_stale in (False, True):
            for extra in candidates:
                if len(topics) >= count:
                    break
                if any(
                    _similar(extra["title"], kept["title"]) > 0.5 or _similar(extra["planned"], kept["planned"]) > 0.55
                    or _covered(extra, kept)
                    for kept in topics
                ):
                    continue
                if not allow_stale and previous and any(_similar(extra["planned"], old) > 0.5 for old in previous):
                    continue
                topics.append(extra)
        if len(topics) < 2 and plan_source.strip():
            subject = " ".join(plan_source.split()[:4])
            for angle in _ANGLES[: count - len(topics)]:
                topics.append(_new_topic(len(topics), subject, "fundamentals", plan_source.strip().splitlines()[0][:160], f"On {subject}: {angle}"))
        if len(topics) < 2:
            raise ValueError("Couldn't build a plan from that material. Add a little more detail and try again.")
    if mode == "resume" and len(areas) == 1:
        for topic in topics:
            if topic["kind"] not in ("behavioral", "gap"):
                topic["kind"] = sections.AREA_KINDS[areas[0]]
    for index, topic in enumerate(topics):
        topic["id"] = f"t{index + 1}"
    yield {"type": "plan", "topics": topics}

    now = time.time()
    session = {
        "id": uuid.uuid4().hex[:16],
        "createdAt": now,
        "updatedAt": now,
        "mode": mode,
        "title": title,
        "role": role,
        "model": model,
        "config": {
            "persona": persona_key,
            "personaName": prompts.PERSONAS[persona_key]["name"] if not payload.get("customPersona") else _brace_safe(payload.get("customPersona"), 60),
            "style": style,
            "length": length_key,
            "areas": areas,
            "startDifficulty": difficulty,
            "focus": focus,
            "jd": jd,
            "company": company,
        },
        "profile": profile,
        "gaps": gaps,
        "topics": topics,
        "messages": [_message("interviewer", greeting, "greeting", None, difficulty)],
        "active": None,
        "difficulty": difficulty,
        "difficultyTrail": [difficulty],
        "complete": False,
        "endedEarly": False,
        "review": None,
        "source": source if mode == "resume" else plan_source,
        "fingerprint": fingerprint,
    }
    (repo or store.DEFAULT).save(session)
    _pool.submit(_index, session)  # build embeddings in the background
    yield {"type": "session", "session": public(session)}


# ----------------------------------------------------------------------------- the interview loop

def _assess(session: dict, question: str, answer: str, topic: dict) -> dict:
    fallback = {
        "status": "thin",
        "score": 4,
        "strength": "",
        "gap": "Add a concrete example with what you did and the result.",
        "quote": " ".join(answer.split()[:12]),
        "sharper": "",
        "probe": "",
        "star": {"situation": False, "task": False, "action": False, "result": False},
    }
    if analytics.is_pass(answer):
        fallback.update(status="skipped", score=0, gap="Skipped. Review this topic before the real interview.", quote="")
        return fallback
    if analytics.is_nonanswer(answer):
        fallback.update(
            status="off_topic", score=0, quote="",
            gap="That wasn't an answer. Say what you did, how you did it, and what happened.",
            probe="",
        )
        return fallback
    # Trust check: an independent second grader runs in parallel, on a different model family when a
    # backup provider is configured, so the two grades can be compared (inter-rater agreement).
    second_meta: dict = {}
    second_job = _pool.submit(
        llm.chat,
        [{"role": "user", "content": prompts.second_grade_prompt(question, answer, topic["title"], session["mode"], session["difficulty"])}],
        model=session.get("model"), temperature=0.1, max_tokens=120, schema=prompts.SECOND_GRADE_SCHEMA,
        prefer_backup=True, meta=second_meta,
    )
    first_meta: dict = {}
    try:
        raw = llm.chat(
            [{"role": "user", "content": prompts.assess_prompt(question, answer, topic["title"], session["mode"], session["difficulty"])}],
            model=llm.fast_model(session.get("model")), temperature=0.15, max_tokens=420, schema=prompts.ASSESS_SCHEMA, meta=first_meta,
        )
    except llm.LLMError:
        # The main grader is unavailable: use the independent grader's score if it answered, so a
        # non-answer is never given a default pass mark.
        words = len(answer.split())
        try:
            second = second_job.result(timeout=20)
            score = max(0, min(10, int(second.get("score", -1))))
            reason = " ".join(str(second.get("reason", "")).split())[:300]
        except Exception:
            score, reason = (2 if words < 12 else 4), ""
        if words < 12:
            score = min(score, 3)
        fallback.update(score=score, status="covered" if score >= 6 else "thin", gap=reason or fallback["gap"])
        return fallback
    result = dict(fallback)
    status = str(raw.get("status", "")).lower()
    result["status"] = status if status in ("covered", "thin", "off_topic") else "thin"
    try:
        result["score"] = max(0, min(10, int(raw.get("score", 4))))
    except (TypeError, ValueError):
        pass
    for key in ("strength", "gap", "sharper", "probe"):
        if isinstance(raw.get(key), str):
            result[key] = " ".join(raw[key].split())[:600]
    quote = " ".join(str(raw.get("quote", "")).split()).strip("\"'")
    result["quote"] = quote if quote and quote.lower() in answer.lower() else fallback["quote"]
    star = raw.get("star") if isinstance(raw.get("star"), dict) else {}
    result["star"] = {key: bool(star.get(key)) for key in ("situation", "task", "action", "result")}
    # Guardrails so grades can't contradict the obvious.
    words = len(answer.split())
    if words < 12:
        result["status"] = "thin"
        result["score"] = min(result["score"], 3)
    if result["status"] == "covered" and result["score"] < 4:
        result["status"] = "thin"
    if result["status"] == "off_topic":
        result["score"] = min(result["score"], 3)
    try:
        second = second_job.result(timeout=8)
        s2 = max(0, min(10, int(second.get("score", -1))))
    except Exception:  # the check is best-effort: never block or fail the answer on it
        s2 = None
    if s2 is not None:
        if words < 12:
            s2 = min(s2, 3)
        if result["status"] == "off_topic":
            s2 = min(s2, 3)
        s1 = result["score"]
        diff = abs(s1 - s2)
        result["check"] = {
            "first": s1, "second": s2, "diff": diff, "agree": diff <= 1,
            "firstBy": _judge_name(first_meta.get("provider")), "secondBy": _judge_name(second_meta.get("provider")),
            "reason": " ".join(str(second.get("reason", "")).split())[:220],
        }
        # Two raters beat one: the reported grade is their average.
        result["score"] = round((s1 + s2) / 2 + 1e-9)
        if result["status"] == "covered" and result["score"] < 4:
            result["status"] = "thin"
    return result


def _judge_name(provider: str | None) -> str:
    return {"Groq": "gpt-oss (Groq)", "Gemini": "Gemini", "Mistral": "Mistral"}.get(provider or "", provider or "AI")


def trust_stats(session: dict) -> dict | None:
    """Agreement between the two independent graders across the interview."""
    pairs = [m["assessment"]["check"] for m in session["messages"] if m["role"] == "candidate" and (m.get("assessment") or {}).get("check")]
    if not pairs:
        return None
    n = len(pairs)
    first = [p["first"] for p in pairs]
    second = [p["second"] for p in pairs]
    within = sum(1 for p in pairs if p["diff"] <= 1)
    exact = sum(1 for p in pairs if p["diff"] == 0)
    mad = sum(p["diff"] for p in pairs) / n
    corr = None
    if n >= 3:
        ma, mb = sum(first) / n, sum(second) / n
        va = sum((a - ma) ** 2 for a in first)
        vb = sum((b - mb) ** 2 for b in second)
        if va > 0 and vb > 0:
            corr = round(sum((a - ma) * (b - mb) for a, b in zip(first, second)) / math.sqrt(va * vb), 2)
    judges = sorted({p["firstBy"] for p in pairs} | {p["secondBy"] for p in pairs})
    return {
        "answers": n,
        "within1": round(100 * within / n),
        "exact": round(100 * exact / n),
        "meanGap": round(mad, 2),
        "correlation": corr,
        "crossModel": any(p["firstBy"] != p["secondBy"] for p in pairs),
        "judges": judges,
        "pairs": [{"first": p["first"], "second": p["second"]} for p in pairs],
    }


_PRAISE = re.compile(
    r"\b(great|good|nice|excellent|awesome|impressive|interesting|wonderful|fantastic|perfect|love|cool|brilliant|solid|"
    r"thanks for sharing|thank you|well done|amazing|sounds)\b",
    re.I,
)
_PLAIN = {
    "low": ["That doesn't really answer it.", "I'd need a lot more than that in a real interview.", "That's not an answer I can assess.", "Let's not leave it there."],
    "move": ["Let's move on.", "Okay, moving on.", "Let's try another area."],
    "intro": ["Alright, let's go straight into it.", "Okay, let's get started."],
}


def _calibrate(question: str, score: int | None, status: str, intro_thin: bool, moving_on: bool) -> str:
    """Strip unearned praise from the opening and make the reaction match the grade."""
    weak = intro_thin or status in ("skipped", "off_topic") or (score is not None and score <= 5)
    if not weak:
        return question
    mark = question.find("?")
    head, tail = question[: mark + 1], question[mark + 1 :]
    sentences = re.split(r"(?<=[.!])\s+", head.strip())
    while len(sentences) > 1 and _PRAISE.search(sentences[0]):
        sentences.pop(0)
    body = " ".join(sentences).strip()
    if len(sentences) == 1 and _PRAISE.match(body):
        body = re.sub(r"^[^,.!?]*[,.!]\s*", "", body, count=1) or body
        body = body[:1].upper() + body[1:]
    if intro_thin:
        lead = random.choice(_PLAIN["intro"])
    elif status == "skipped":
        lead = "No problem, let's move on."
    elif score is not None and score <= 3:
        lead = random.choice(_PLAIN["move"] if moving_on else _PLAIN["low"])
    else:
        return (body + tail).strip()
    already = re.search(
        r"(does ?n[o']t|did ?n[o']t|does not|did not) (really |quite )?(answer|address)|not (really )?an answer|need (a lot |much )?more|let'?s move on|moving on",
        body, re.I,
    )
    if already or lead.lower().rstrip(".") in body.lower():
        return (body + tail).strip()  # the model already reacted honestly; don't stack a second reaction
    return f"{lead} {body}{tail}".strip()


def _next_question(session: dict, topic: dict, followup: bool, probe: str, reaction: str = "") -> Iterator[dict]:
    """Stream the interviewer's next line; yields token events then a final 'question' text."""
    index = _index(session)
    asked = [m["content"] for m in session["messages"] if m["role"] == "interviewer" and m["kind"] in ("question", "followup")]
    passage = "\n---\n".join(index.search(f"{topic['title']} {topic['evidence']} {probe}", k=2))[:1200]
    messages = [
        {"role": "system", "content": prompts.ask_system(session["config"]["style"], session["difficulty"], session["mode"])},
        {"role": "user", "content": prompts.ask_user(topic, passage, _transcript(session["messages"], last=4), followup, probe, asked, reaction)},
    ]
    text = ""
    generator = llm.stream(
        messages, model=llm.fast_model(session.get("model")), temperature=0.6, max_tokens=140, stop=["\nCandidate", "Candidate:", "\n\n\n"]
    )
    try:
        for chunk in generator:
            text += chunk
            yield {"type": "token", "text": chunk}
            if "?" in text and len(text) > 20:
                break  # one question only: stop the model as soon as it has asked
    finally:
        generator.close()
    question = _first_question(text)
    usable = "?" in question and len(question) >= 12 and (followup or _keeps_evidence(question, topic))
    if usable and _is_repeat(question, asked):
        # One retry, hotter and explicitly told what not to ask.
        try:
            retry = llm.chat(
                messages + [
                    {"role": "assistant", "content": question},
                    {"role": "user", "content": "That repeats an earlier question. Ask something genuinely different about the same topic. One question only."},
                ],
                model=llm.fast_model(session.get("model")), temperature=0.9, max_tokens=120,
            )
            question = _first_question(retry)
            usable = "?" in question and len(question) >= 12 and not _is_repeat(question, asked)
        except llm.LLMError:
            usable = False
    if not usable:
        question = _fresh_fallback(topic, asked, followup, probe)
    yield {"type": "final", "text": question}


_ANGLES = [
    "What exactly was your own contribution there, and how did you measure whether it worked?",
    "What was the hardest trade-off you made there, and what did you give up?",
    "If you started it again tomorrow, what would you do differently, and why?",
    "Walk me through one specific decision in detail. What were the options, and why did you pick yours?",
    "What went wrong along the way, and how did you handle it?",
    "How would you explain the core idea to someone non-technical in thirty seconds?",
]


def _fresh_fallback(topic: dict, asked: list[str], followup: bool, probe: str) -> str:
    """Deterministic last resort that is guaranteed not to repeat an earlier question."""
    candidates: list[str] = []
    planned = topic["planned"].rstrip()
    if followup and not probe:
        candidates += [f"Let me ask that again, more simply. {planned}", f"Take another shot at this one. {planned}"]
    if not followup:
        candidates.append(planned)
    if topic.get("real"):
        candidates += [f"Let me put it another way. {planned}", f"One more time, in your own words. {planned}"]
    if probe and len(probe) < 140:
        focus = probe.rstrip(" .?")
        candidates.append(f"Let's go a level deeper on {topic['title']}. Specifically: {focus[:1].lower() + focus[1:]}?")
    subject = topic["title"] if len(topic["title"]) > 2 else topic["evidence"][:60]
    candidates += [f"On {subject}: {angle}" for angle in _ANGLES]
    for candidate in candidates:
        if candidate and not _is_repeat(candidate, asked):
            return _punctuate(candidate)
    return f"Is there anything about {subject} you haven't told me yet that you'd want an interviewer to know?"


def reply(session_id: str, content: str, duration: float | None = None, via: str = "text", repo=None) -> Iterator[dict]:
    text = (content or "").strip()
    if not text:
        raise ValueError("Write or record an answer first.")
    if len(text) > 6000:
        raise ValueError("That answer is very long. Keep it under about 800 words.")
    lock = _lock(session_id)
    if not lock.acquire(timeout=1):
        raise ValueError("Still working on your last answer.")
    try:
        session = get(session_id, repo)
        if session["complete"]:
            raise ValueError("This interview is finished. Open the review.")
        question = next((m["content"] for m in reversed(session["messages"]) if m["role"] == "interviewer"), "")
        answer = _message("candidate", text, "answer", session["active"], session["difficulty"])
        answer["via"] = via
        answer["delivery"] = analytics.delivery(text, duration)
        session["messages"].append(answer)
        yield {"type": "answer", "message": answer}

        followup = False
        probe = ""
        grade: dict = {"score": None, "status": "", "gap": "", "strength": ""}
        intro_thin = False
        if session["active"] is None:
            next_index = 0
            intro_thin = analytics.is_nonanswer(text) or len(text.split()) < 6
        else:
            topic = session["topics"][session["active"]]
            assessment = _assess(session, question, text, topic)
            grade = assessment
            answer["assessment"] = assessment
            yield {"type": "assessment", "messageId": answer["id"], "assessment": assessment}
            topic["score"] = max(topic["score"] or 0, assessment["score"]) if assessment["status"] != "skipped" else (topic["score"] or 0)
            # Adaptive difficulty: climb after strong answers, ease off after weak ones.
            if assessment["score"] >= 8:
                session["difficulty"] = min(5, session["difficulty"] + 1)
            elif assessment["score"] <= 4 and assessment["status"] != "skipped":
                session["difficulty"] = max(1, session["difficulty"] - 1)
            session["difficultyTrail"].append(session["difficulty"])
            limit = 2 if session["config"]["persona"] == "bar_raiser" else 1
            wants_more = assessment["status"] in ("thin", "off_topic") or (
                session["config"]["persona"] == "bar_raiser" and assessment["score"] < 7 and assessment["probe"]
            )
            if assessment["status"] != "skipped" and wants_more and topic["followups"] < limit:
                topic["followups"] += 1
                topic["status"] = "thin"
                followup = True
                # A non-answer gets the question re-asked plainly, not a "probe" built from the grader's note.
                probe = assessment["probe"] or ("" if assessment["score"] == 0 else assessment["gap"])
                next_index = session["active"]
            else:
                topic["status"] = "covered" if assessment["status"] == "covered" else (
                    "skipped" if assessment["status"] == "skipped" else "thin"
                )
                next_index = next(
                    (i for i in range(session["active"] + 1, len(session["topics"])) if session["topics"][i]["status"] == "pending"),
                    None,
                )
            yield {"type": "difficulty", "difficulty": session["difficulty"]}

        if next_index is None:
            closing = {
                "coach": "That's everything I wanted to cover. Really nice work today. Your review is ready whenever you are.",
                "professional": "That covers everything I wanted to ask. Thank you for your time. Your review is ready.",
                "bar_raiser": "That's the round. Thanks. Your review is ready.",
            }.get(session["config"]["persona"], "That covers everything. Thank you. Your review is ready.")
            session["complete"] = True
            session["active"] = None
            message = _message("interviewer", closing, "closing", None, session["difficulty"])
            session["messages"].append(message)
            (repo or store.DEFAULT).save(session)
            yield {"type": "question", "message": message}
            yield {"type": "done", "session": public(session)}
            return

        (repo or store.DEFAULT).save(session)  # persist the graded answer before the slower generation step
        topic = session["topics"][next_index]
        session["active"] = next_index
        message = _message("interviewer", "", "followup" if followup else "question", next_index, session["difficulty"])
        yield {"type": "start", "message": message}
        final = topic["planned"]
        try:
            reaction = prompts.reaction_guide(grade["score"], grade["status"], grade["gap"], grade["strength"], intro_thin)
            for event in _next_question(session, topic, followup, probe, reaction):
                if event["type"] == "token":
                    yield event
                else:
                    final = _calibrate(event["text"], grade["score"], grade["status"], intro_thin, moving_on=not followup)
        except llm.LLMError as error:
            yield {"type": "warning", "detail": str(error)}
        message["content"] = final
        session["messages"].append(message)
        (repo or store.DEFAULT).save(session)
        yield {"type": "question", "message": message}
        yield {"type": "done", "session": public(session)}
    finally:
        lock.release()


def hint(session_id: str, repo=None) -> dict:
    session = get(session_id, repo)
    if session["complete"] or session["active"] is None:
        return {"hint": "Start with a 45-second introduction: who you are, what you've built, and what you want next.",
                "structure": ["Current role or studies", "One project you're proud of, with a result", "Why this role"]}
    topic = session["topics"][session["active"]]
    question = next((m["content"] for m in reversed(session["messages"]) if m["role"] == "interviewer"), topic["planned"])
    passage = "\n".join(_index(session).search(f"{topic['title']} {topic['evidence']}", k=2))[:900]
    try:
        raw = llm.chat(
            [{"role": "user", "content": prompts.hint_prompt(question, topic, passage)}],
            model=llm.fast_model(session.get("model")), temperature=0.4, max_tokens=260, schema=prompts.HINT_SCHEMA,
        )
        return {"hint": str(raw.get("hint", ""))[:500], "structure": _clean_list(raw.get("structure"), 4)}
    except llm.LLMError:
        star = topic["kind"] == "behavioral"
        return {
            "hint": f"Anchor your answer in {topic['evidence'] or topic['title']}.",
            "structure": ["Situation & goal", "What you did, specifically", "The measurable result"] if star
            else ["Define it in a sentence", "Show where you used it", "Name a trade-off you weighed"],
        }


def end(session_id: str, repo=None) -> dict:
    with _lock(session_id):
        session = get(session_id, repo)
        if not session["complete"]:
            session["complete"] = True
            session["endedEarly"] = True
            session["active"] = None
            (repo or store.DEFAULT).save(session)
    return public(session)


def review(session_id: str, refresh: bool = False, repo=None) -> dict:
    with _lock(session_id):
        session = get(session_id, repo)
        if session.get("review") and not refresh:
            return {**session["review"], "readiness": _readiness(_scoring(session)["score"]), "session": public(session)}
        answers = [m for m in session["messages"] if m["role"] == "candidate" and m.get("assessment")]
        if not answers:
            raise ValueError("Answer at least one question (after your introduction) to get a review.")
        scoring = _scoring(session)
        coverage = "\n".join(f"- {t['title']}: {t['status']} (score {t['score'] if t['score'] is not None else '-'})" for t in session["topics"])
        transcript = _clip(_transcript(session["messages"]), 10000)
        competencies = None
        narrative = {}
        try:
            narrative = llm.chat(
                [{"role": "user", "content": prompts.review_prompt(session["mode"], session["title"], transcript, coverage, scoring["average"])}],
                model=session.get("model"), temperature=0.3, max_tokens=1100, schema=prompts.REVIEW_SCHEMA,
            )
            raw_comp = narrative.get("competencies") or {}
            competencies = [
                {"key": key, "label": label, "score": max(0, min(10, int(raw_comp.get(key, 0) or 0)))}
                for key, label in prompts.COMPETENCY_LABELS.items()
            ]
        except (llm.LLMError, TypeError, ValueError):
            narrative = {}
        delivered = [m["delivery"] for m in session["messages"] if m["role"] == "candidate" and m.get("delivery")]
        fillers: dict[str, int] = {}
        for item in delivered:
            for word, n in item["fillers"].items():
                fillers[word] = fillers.get(word, 0) + n
        wpms = [item["wpm"] for item in delivered if item.get("wpm")]
        star_counts = {key: 0 for key in ("situation", "task", "action", "result")}
        for message in answers:
            for key, value in message["assessment"]["star"].items():
                star_counts[key] += int(bool(value))
        if competencies is None or not any(c["score"] for c in competencies):
            avg = round(scoring["average"])
            clarity = round(sum(d["clarity"] for d in delivered) / len(delivered) / 10) if delivered else avg
            competencies = [
                {"key": key, "label": label, "score": clarity if key == "communication" else avg}
                for key, label in prompts.COMPETENCY_LABELS.items()
            ]
        result = {
            "score": scoring["score"],
            "readiness": _readiness(scoring["score"]),
            "provisional": scoring["provisional"],
            "headline": _brace_safe(narrative.get("headline", ""), 160) or _readiness(scoring["score"]),
            "summary": _brace_safe(narrative.get("summary", ""), 900),
            "strengths": _clean_list(narrative.get("strengths"), 4),
            "improvements": _clean_list(narrative.get("improvements"), 4),
            "plan": [
                {"title": _brace_safe(p.get("title", ""), 80), "detail": _brace_safe(p.get("detail", ""), 260)}
                for p in (narrative.get("plan") or []) if isinstance(p, dict) and p.get("title")
            ][:3],
            "competencies": competencies,
            "delivery": {
                "answers": len(delivered),
                "words": sum(d["words"] for d in delivered),
                "avgWords": round(sum(d["words"] for d in delivered) / len(delivered)) if delivered else 0,
                "fillers": dict(sorted(fillers.items(), key=lambda kv: -kv[1])[:6]),
                "fillerCount": sum(fillers.values()),
                "wpm": round(sum(wpms) / len(wpms)) if wpms else None,
                "clarity": round(sum(d["clarity"] for d in delivered) / len(delivered)) if delivered else None,
                "numbers": sum(d["numbers"] for d in delivered),
            },
            "star": star_counts if session["mode"] == "behavioral" or any(star_counts.values()) else None,
            "difficultyTrail": session.get("difficultyTrail", []),
            "trust": trust_stats(session),
            "generatedAt": time.time(),
        }
        if not narrative:
            # The AI write-up failed (usually free quota). Build the report from the graders' own notes
            # so it is never empty: what the best answers did well, what the weakest ones missed.
            ranked = sorted(answers, key=lambda m: -m["assessment"]["score"])
            def _unique(values):
                seen, out = set(), []
                for value in values:
                    if value and value.lower() not in seen:
                        seen.add(value.lower())
                        out.append(value)
                return out
            result["strengths"] = result["strengths"] or _unique(m["assessment"]["strength"] for m in ranked if m["assessment"]["score"] >= 6)[:3]
            weak = [m for m in reversed(ranked) if m["assessment"]["score"] <= 5]
            result["improvements"] = result["improvements"] or _unique(m["assessment"]["gap"] for m in weak)[:3]
            topic_title = lambda m: session["topics"][m["topic"]]["title"] if isinstance(m.get("topic"), int) and m["topic"] < len(session["topics"]) else ""
            strong_titles = _unique(topic_title(m) for m in ranked if m["assessment"]["score"] >= 7)[:3]
            weak_titles = _unique(topic_title(m) for m in weak)[:3]
            parts = [f"You scored {scoring['score']} out of 100 across {len(answers)} graded answers."]
            if strong_titles:
                parts.append("Strongest: " + ", ".join(strong_titles) + ".")
            if weak_titles:
                parts.append("Needs work: " + ", ".join(weak_titles) + ".")
            result["summary"] = result["summary"] or " ".join(parts)
            result["plan"] = result["plan"] or [
                {"title": f"Rehearse {title}", "detail": "Answer it again out loud with one concrete example, what you did yourself, and the result in numbers."}
                for title in weak_titles[:3]
            ]
        session["review"] = result
        (repo or store.DEFAULT).save(session)
        return {**result, "session": public(session)}


# ----------------------------------------------------------------------------- drill weak spots

def drill(session_id: str, repo=None) -> dict:
    """Start a focused follow-up session on the topics the candidate struggled with,
    with fresh questions that avoid everything asked before."""
    old = get(session_id, repo)
    answered = [t for t in old["topics"] if t["status"] != "pending"]
    weak = [t for t in answered if t["status"] in ("thin", "skipped") or (t["score"] is not None and t["score"] < 7)]
    if not weak:
        weak = sorted(answered, key=lambda t: t["score"] or 0)[:2]
    if not weak:
        raise ValueError("Answer a few questions first, then drill the weak ones.")
    weak = weak[:6]
    avoid = [m["content"] for m in old["messages"] if m["role"] == "interviewer" and m["kind"] in ("question", "followup")]
    avoid += _previous_questions(old.get("fingerprint", ""), repo=repo)
    source = old["source"]
    fresh: list[dict] = []
    try:
        raw = llm.chat(
            [{"role": "user", "content": prompts.drill_prompt(weak, _clip(source), avoid)}],
            model=old.get("model"), temperature=0.6, max_tokens=1000, schema=prompts.PLAN_SCHEMA,
        )
        fresh = [item for item in (raw.get("topics") or []) if isinstance(item, dict) and item.get("question")]
    except llm.LLMError:
        fresh = []
    topics = []
    for index, base in enumerate(weak):
        item = fresh[index] if index < len(fresh) else {}
        question = str(item.get("question", "")).strip()
        if not question or _is_repeat(question, avoid):
            question = f"Let's come back to {base['title']}. Take a different angle this time: what was the hardest decision you made there, and why?"
        question = _punctuate(question)
        topic = _new_topic(index, base["title"], base["kind"], base["evidence"], question)
        topics.append(topic)
    now = time.time()
    intro = "Let's revisit the areas that were shaky last time. "
    first = topics[0]["planned"]
    config = dict(old["config"])
    config["length"] = "drill"
    session = {
        **{key: old[key] for key in ("mode", "role", "model", "profile", "gaps", "source")},
        "id": uuid.uuid4().hex[:16],
        "createdAt": now,
        "updatedAt": now,
        "title": f"Drill: {old['title']}",
        "config": config,
        "topics": topics,
        "messages": [_message("interviewer", intro + first, "question", 0, old["config"].get("startDifficulty", 2))],
        "active": 0,
        "difficulty": old["config"].get("startDifficulty", 2),
        "difficultyTrail": [old["config"].get("startDifficulty", 2)],
        "complete": False,
        "endedEarly": False,
        "review": None,
        "fingerprint": old.get("fingerprint", ""),
        "drillOf": old["id"],
    }
    (repo or store.DEFAULT).save(session)
    _pool.submit(_index, session)
    return public(session)

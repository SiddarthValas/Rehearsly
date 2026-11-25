"""Mirror mode: the user is the interviewer, the AI is a candidate with a hidden persona.

The server is stateless. The candidate's secret (persona, private notes, the flaw planted in
each answer) travels with the browser inside sealed tokens: encrypted with a keystream derived
from a server secret and authenticated with HMAC, so the browser can store them but can't read
or forge them. The user flags answers as solid or weak; the reveal scores how well they spotted
the planted problems and how good their questions were."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import random
import re
from typing import Iterator

from server import llm

_SECRET = (os.getenv("MIRROR_SECRET") or hashlib.sha256(f"rehearsly-mirror:{llm.GROQ_KEY or 'local'}".encode()).hexdigest()).encode()


def _stream_key(nonce: bytes, size: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < size:
        out += hashlib.sha256(_SECRET + nonce + counter.to_bytes(4, "big")).digest()
        counter += 1
    return bytes(out[:size])


def seal(data: dict) -> str:
    raw = json.dumps(data, separators=(",", ":")).encode()
    nonce = os.urandom(12)
    body = bytes(a ^ b for a, b in zip(raw, _stream_key(nonce, len(raw))))
    tag = hmac.new(_SECRET, nonce + body, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(nonce + tag + body).decode().rstrip("=")


def unseal(token: str) -> dict:
    try:
        blob = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        nonce, tag, body = blob[:12], blob[12:28], blob[28:]
        if not hmac.compare_digest(tag, hmac.new(_SECRET, nonce + body, hashlib.sha256).digest()[:16]):
            raise ValueError
        return json.loads(bytes(a ^ b for a, b in zip(body, _stream_key(nonce, len(body)))))
    except Exception as error:  # noqa: BLE001 - any tampering or corruption looks the same
        raise ValueError("This mirror session can't be read anymore. Start a new one.") from error


# ----------------------------------------------------------------------------- personas and flaws

PERSONAS = {
    "strong": {"label": "The genuine article", "about": "A strong candidate who knows their work. Almost every answer was solid.",
               "flaws": {"none": 0.85, "vague": 0.15}},
    "bluffer": {"label": "The bluffer", "about": "Confident and fluent, but inflated their role and stated things that aren't quite true.",
                "flaws": {"none": 0.4, "bluff": 0.45, "contradiction": 0.15}},
    "rambler": {"label": "The rambler", "about": "Knows the material but buries it: long, wandering answers that drift off the question.",
                "flaws": {"none": 0.45, "ramble": 0.45, "dodge": 0.1}},
    "vague": {"label": "The generalist", "about": "Says all the right words with none of the specifics: no numbers, no 'I', no details.",
              "flaws": {"none": 0.4, "vague": 0.5, "dodge": 0.1}},
    "mixed": {"label": "The mixed bag", "about": "Some great answers, some weak ones of every kind.",
              "flaws": {"none": 0.45, "bluff": 0.15, "ramble": 0.15, "vague": 0.15, "dodge": 0.1}},
}
FLAWS = {
    "none": ("Solid", "Answer well: specific, first person, a concrete example with what you did and a measurable result. 70 to 120 words."),
    "bluff": ("Bluff", "Bluff convincingly: overstate your personal role, or state one technical detail that is subtly wrong, with total confidence. 70 to 120 words. Don't hint that you're bluffing."),
    "ramble": ("Ramble", "Ramble: start on the question, then drift into loosely related background and tangents, and only half answer it. 170 to 230 words."),
    "vague": ("Vague", "Be vague: sound polished but give no specifics at all, no numbers, no concrete example, lots of 'we' and buzzwords. 60 to 100 words."),
    "dodge": ("Dodge", "Dodge: answer a slightly different, easier question than the one asked, smoothly enough that it's easy to miss. 70 to 110 words."),
    "contradiction": ("Contradiction", "Contradict something you said earlier in this interview (a date, a number, your role, a tool), casually, as if it's consistent. 70 to 120 words. If nothing earlier to contradict, bluff instead."),
}
VOICES = ["troy", "austin", "hannah"]
CANDIDATES = {"man": "Ambar Gairola", "woman": "Aanya"}  # the two regular candidates; the voice decides which one walks in

PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "headline": {"type": "string"},
        "resume": {"type": "array", "items": {"type": "string"}},
        "truth": {"type": "array", "items": {"type": "string"}},
        "questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "headline", "resume", "truth", "questions"],
}
REVEAL_SCHEMA = {
    "type": "object",
    "properties": {
        "explanations": {"type": "array", "items": {"type": "object", "properties": {"turn": {"type": "integer"}, "why": {"type": "string"}}, "required": ["turn", "why"]}},
        "questioning": {"type": "integer"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "missedFollowup": {"type": "string"},
    },
    "required": ["explanations", "questioning", "strengths", "improvements", "missedFollowup"],
}


def _clean(text: str, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def _item(text: str, limit: int) -> str:
    """A list entry without the "1." or "- " the model sometimes puts in front."""
    text = re.sub(r"^\s*(?:[-*•]|\(?\d{1,2}[.)])\s*", "", _clean(text, limit * 2))
    return _trim(text, limit)


def _trim(text: str, limit: int) -> str:
    """Shorten without cutting a word in half: prefer the last full sentence, else the last whole word."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    if end >= limit * 0.6:
        return cut[: end + 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > 0 else cut).rstrip(" ,;:-") + "..."


def start(role: str, persona: str = "") -> dict:
    role = _clean(role, 80) or "Software engineer"
    key = persona if persona in PERSONAS else random.choice(list(PERSONAS))
    gender = random.choice(["man", "woman"])  # Ambar or Aanya, even odds
    voice = "hannah" if gender == "woman" else random.choice(["troy", "austin"])
    note = {
        "strong": "Their real experience is solid and matches the resume.",
        "bluffer": "One or two resume lines are inflated: they were a minor contributor, or a number is exaggerated.",
        "rambler": "Real experience, modest and honest.",
        "vague": "Real but shallow experience; they rarely did the hard part themselves.",
        "mixed": "A mix: some lines strong, one inflated.",
    }[key]
    try:
        raw = llm.chat(
            [{"role": "user", "content": f"""Invent the background of a job candidate named {CANDIDATES[gender]} (a {gender}) applying for: {role}. Early-career (0 to 3 years), realistic for India.
- name: "{CANDIDATES[gender]}".
- headline: one line, e.g. "Final-year CS student, ex-intern at a fintech startup".
- resume: 5 short resume lines with specific projects, tools and numbers.
- truth: 2 private notes on what's really behind the resume. {note}
- questions: 6 good questions an interviewer could ask this candidate for this role, mixing behavioural and technical, each tied to the resume."""}],
            model=llm.fast_model(None), temperature=0.9, max_tokens=1300, schema=PROFILE_SCHEMA,
        )
    except llm.LLMError:
        raw = {}
    profile = {
        "name": CANDIDATES[gender],
        "headline": _clean(raw.get("headline"), 120) or f"Early-career candidate for {role}",
        "resume": [_item(x, 220) for x in raw.get("resume") or [] if _item(x, 220)][:6] or [f"Built a small project related to {role}"],
        "truth": [_item(x, 320) for x in raw.get("truth") or []][:3],
    }
    questions = [_item(q, 220) for q in raw.get("questions") or [] if len(_item(q, 220)) > 10][:6]
    secret = {"persona": key, "role": role, "profile": profile, "voice": voice}
    return {
        "candidate": {"name": profile["name"], "headline": profile["headline"], "resume": profile["resume"], "voice": voice},
        "suggested": questions,
        "role": role,
        "sealed": seal(secret),
    }


SELF_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "highlights": {"type": "array", "items": {"type": "string"}},
        "questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["headline", "highlights", "questions"],
}
NOTES_SCHEMA = {
    "type": "object",
    "properties": {
        "structure": {"type": "string"},
        "moves": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["structure", "moves"],
}


def start_self(name: str, role: str, resume: str, voice: str = "") -> dict:
    """Interview yourself: the AI answers as the user, using only their resume, as a model answer."""
    name = _clean(name, 60)
    if len(name) < 2:
        raise ValueError("Tell us your name first.")
    resume = (resume or "").strip()[:6000]
    if len(resume.split()) < 25:
        raise ValueError("Add your resume (upload it or paste the text) so your AI self has something to answer from.")
    role = _clean(role, 80) or "the role you're applying for"
    voice = voice if voice in VOICES else "hannah"
    try:
        raw = llm.chat(
            [{"role": "user", "content": f"""This is {name}'s resume. They are preparing for: {role}.
{resume}

- headline: one line describing them, from the resume only.
- highlights: the 5 most interview-worthy lines from the resume (projects, internships, results), lightly shortened, keeping every number exactly.
- questions: 6 questions a strong interviewer would ask {name} for this role, each tied to something specific on the resume, mixing technical depth, impact and behaviour. One question each, under 30 words, spoken style."""}],
            model=llm.fast_model(None), temperature=0.4, max_tokens=1500, schema=SELF_SCHEMA,
        )
    except llm.LLMError:
        raw = {}
    lines = [line.strip(" •-*") for line in resume.splitlines() if len(line.split()) >= 5]
    profile = {
        "name": name,
        "headline": _clean(raw.get("headline"), 140) or f"Candidate for {role}",
        "resume": [_item(x, 180) for x in raw.get("highlights") or [] if _item(x, 180)][:6] or [_clean(x, 180) for x in lines[:5]],
        "truth": [],
    }
    questions = [_item(q, 400) for q in raw.get("questions") or [] if len(_item(q, 400)) > 10][:6]
    secret = {"persona": "self", "role": role, "profile": profile, "voice": voice, "source": resume}
    return {
        "candidate": {"name": profile["name"], "headline": profile["headline"], "resume": profile["resume"], "voice": voice},
        "suggested": questions,
        "role": role,
        "sealed": seal(secret),
    }


def _self_answer(secret: dict, turns: list[dict], question: str) -> Iterator[dict]:
    profile = secret["profile"]
    earlier = "\n".join(f"Interviewer: {_clean(t.get('question'), 300)}\nYou: {_clean(t.get('answer'), 600)}" for t in turns)
    prompt = f"""You are {profile['name']}, interviewing for {secret['role']}. Give the answer a well-prepared version of {profile['name']} would give: the model answer they can learn from.
Your resume (the only source of facts about you):
{secret['source']}

Interview so far:
{earlier or '(this is the first question)'}

The interviewer asks: "{question}"

Rules:
- First person, spoken naturally, 90 to 160 words. No lists, no headings, no quotation marks around the answer.
- Lead with a direct answer, then one concrete example from the resume: the situation, what you yourself did, how, and the result with the resume's real numbers.
- Facts about you come ONLY from the resume. Never add an algorithm, model type, tool, team, reason, constraint or number
  that the resume doesn't state (if it says "churn prediction pipeline in PySpark", don't name the model inside it).
  Where a detail would help but isn't on the resume, describe the approach in general terms ("I compared a few models
  and picked the one with the best recall") rather than inventing a specific.
- Show ownership ("I"), mention one trade-off or lesson, and end with a crisp line that ties back to the question.
- If the "question" is only a greeting, reply briefly and warmly."""
    text = ""
    for token in llm.stream([{"role": "user", "content": prompt}], model=llm.fast_model(None), temperature=0.3, max_tokens=520):
        text += token
        yield {"type": "token", "text": token}
    text = re.sub(r"\s+", " ", text).strip().strip('"')
    notes = {"structure": "", "moves": []}
    try:
        raw = llm.chat(
            [{"role": "user", "content": f"""Interview question: "{question}"
Model answer: "{text}"

Explain to a student why this answer works, so they can copy the technique.
- structure: the shape of the answer in a few words, e.g. "Direct answer → STAR example → lesson".
- moves: 3 short points (under 16 words each) naming specific techniques it used, quoting a few words from the answer."""}],
            model=llm.fast_model(None), temperature=0.2, max_tokens=300, schema=NOTES_SCHEMA,
        )
        notes = {"structure": _clean(raw.get("structure"), 120), "moves": [_item(m, 160) for m in raw.get("moves") or [] if _item(m, 160)][:3]}
    except llm.LLMError:
        pass
    yield {"type": "done", "answer": text, "sealedTurn": seal({"flaw": "none", "q": question[:200]}), "notes": notes}


def _pick_flaw(persona: str, history_flaws: list[str]) -> str:
    weights = dict(PERSONAS[persona]["flaws"])
    if "contradiction" in weights and len(history_flaws) < 2:
        weights["bluff"] = weights.get("bluff", 0) + weights.pop("contradiction")
    # Keep it fair: after two flawed answers in a row, give a clean one; non-strong personas show their flaw early.
    if len(history_flaws) >= 2 and all(f != "none" for f in history_flaws[-2:]):
        return "none"
    if persona != "strong" and len(history_flaws) == 1 and history_flaws[0] == "none":
        weights["none"] = weights["none"] * 0.5
    names, values = zip(*weights.items())
    return random.choices(names, weights=values, k=1)[0]


def answer(sealed: str, history: list[dict], question: str) -> Iterator[dict]:
    secret = unseal(sealed)
    question = _clean(question, 600)
    if len(question) < 2:
        raise ValueError("Ask the candidate a question first.")
    turns = [t for t in history if isinstance(t, dict)][-12:]
    if secret.get("persona") == "self":
        yield from _self_answer(secret, turns, question)
        return
    used = []
    for turn in turns:
        try:
            used.append(unseal(str(turn.get("sealedTurn", ""))).get("flaw", "none"))
        except ValueError:
            used.append("none")
    flaw = _pick_flaw(secret["persona"], used)
    profile = secret["profile"]
    earlier = "\n".join(f"Interviewer: {_clean(t.get('question'), 300)}\nYou: {_clean(t.get('answer'), 600)}" for t in turns)
    prompt = f"""You are {profile['name']}, a job candidate interviewing for {secret['role']}. Stay fully in character as the candidate.
Your resume:
{chr(10).join('- ' + line for line in profile['resume'])}
Private truth about you (never say this outright): {' '.join(profile['truth'])}

Interview so far:
{earlier or '(this is the first question)'}

The interviewer now asks: "{question}"

How to answer this one: {FLAWS[flaw][1]}
If the "question" is just a greeting or small talk, reply naturally and briefly instead.
Speak naturally, as spoken words in an interview, first person. No stage directions, no lists, no quotation marks around your answer."""
    text = ""
    for token in llm.stream([{"role": "user", "content": prompt}], model=llm.fast_model(None), temperature=0.8, max_tokens=420):
        text += token
        yield {"type": "token", "text": token}
    text = re.sub(r"\s+", " ", text).strip().strip('"')
    yield {"type": "done", "answer": text, "sealedTurn": seal({"flaw": flaw, "q": question[:200]})}


def reveal(sealed: str, turns: list[dict]) -> dict:
    secret = unseal(sealed)
    persona = PERSONAS[secret["persona"]]
    rows = []
    for index, turn in enumerate(t for t in turns if isinstance(t, dict)):
        try:
            flaw = unseal(str(turn.get("sealedTurn", ""))).get("flaw", "none")
        except ValueError:
            flaw = "none"
        verdict = turn.get("verdict") if turn.get("verdict") in ("solid", "weak") else None
        truth = "weak" if flaw != "none" else "solid"
        tag = turn.get("tag") if turn.get("tag") in FLAWS else None
        rows.append({
            "turn": index + 1,
            "question": _clean(turn.get("question"), 400),
            "answer": _clean(turn.get("answer"), 1500),
            "flaw": flaw,
            "flawLabel": FLAWS[flaw][0],
            "truth": truth,
            "verdict": verdict,
            "correct": verdict == truth if verdict else None,
            "tagRight": bool(tag and tag == flaw),
            "why": "",
        })
    if not rows:
        raise ValueError("Ask the candidate at least one question first.")
    flawed = [r for r in rows if r["truth"] == "weak"]
    judged = [r for r in rows if r["verdict"]]
    caught = sum(1 for r in flawed if r["verdict"] == "weak")
    false_alarms = sum(1 for r in rows if r["truth"] == "solid" and r["verdict"] == "weak")
    accuracy = round(100 * sum(1 for r in judged if r["correct"]) / len(judged)) if judged else 0
    questioning = {"questioning": 5, "strengths": [], "improvements": [], "missedFollowup": ""}
    try:
        listed = "\n\n".join(f"Turn {r['turn']} [{r['flawLabel']}]\nInterviewer: {r['question']}\nCandidate: {r['answer'][:700]}" for r in rows)
        raw = llm.chat(
            [{"role": "user", "content": f"""A user practised being the interviewer. The candidate, {secret['profile']['name']}, secretly played "{persona['label']}": {persona['about']}
Each candidate answer was deliberately given the flaw in brackets (Solid = no flaw).

{listed}

1. explanations: for every turn whose flaw isn't Solid, explain in under 30 words what exactly was wrong and the giveaway the interviewer could have noticed.
2. questioning: rate the user's questions 0 to 10: open, specific, tied to the resume, following up on suspicious claims, not leading.
3. strengths and improvements: up to 3 each about their interviewing, specific to the questions they asked.
4. missedFollowup: the single best follow-up question they should have asked, quoting the candidate."""}],
            model=None, temperature=0.3, max_tokens=1700, schema=REVEAL_SCHEMA,
        )
        for item in raw.get("explanations") or []:
            if isinstance(item, dict) and isinstance(item.get("turn"), int) and 1 <= item["turn"] <= len(rows):
                rows[item["turn"] - 1]["why"] = _clean(item.get("why"), 260)
        questioning = {
            "questioning": max(0, min(10, int(raw.get("questioning", 5) or 5))),
            "strengths": [_item(x, 200) for x in raw.get("strengths") or [] if _item(x, 200)][:3],
            "improvements": [_item(x, 200) for x in raw.get("improvements") or [] if _item(x, 200)][:3],
            "missedFollowup": _clean(raw.get("missedFollowup"), 300),
        }
    except (llm.LLMError, TypeError, ValueError):
        pass
    detection = round(100 * caught / len(flawed)) if flawed else (100 if not false_alarms else 50)
    overall = round(0.55 * (accuracy if judged else 0) + 0.45 * questioning["questioning"] * 10)
    return {
        "persona": {"key": secret["persona"], "label": persona["label"], "about": persona["about"]},
        "truth": secret["profile"]["truth"],
        "turns": rows,
        "stats": {
            "judged": len(judged), "total": len(rows), "flawed": len(flawed), "caught": caught,
            "falseAlarms": false_alarms, "accuracy": accuracy, "detection": detection, "overall": overall,
        },
        **questioning,
    }

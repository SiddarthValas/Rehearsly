"""Deterministic delivery analytics for each answer (no LLM involved)."""

from __future__ import annotations

import re

FILLERS = [
    "um", "uh", "erm", "uhm", "hmm", "you know", "i mean", "basically", "literally",
    "sort of", "kind of", "like i said", "so yeah", "actually",
]
HEDGES = ["i think", "i guess", "maybe", "probably", "i feel like", "not sure", "i believe", "kind of", "sort of"]
OWNERSHIP_WE = re.compile(r"\bwe\b", re.I)
OWNERSHIP_I = re.compile(r"\bi\b", re.I)
NUMBER = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:%|percent|x|ms|s|k|m|hrs?|hours?|days?|users?|lakh|crore)?", re.I)


def _count(text: str, phrases: list[str]) -> dict[str, int]:
    lowered = f" {text.lower()} "
    found = {}
    for phrase in phrases:
        hits = len(re.findall(rf"(?<![a-z']){re.escape(phrase)}(?![a-z'])", lowered))
        if hits:
            found[phrase] = hits
    return found


def delivery(text: str, duration: float | None = None) -> dict:
    words = re.findall(r"[A-Za-z0-9']+", text)
    count = len(words)
    sentences = [part for part in re.split(r"[.!?]+", text) if part.strip()]
    fillers = _count(text, FILLERS)
    hedges = _count(text, HEDGES)
    numbers = len(NUMBER.findall(text))
    we = len(OWNERSHIP_WE.findall(text))
    i = len(OWNERSHIP_I.findall(text))
    wpm = round(count / (duration / 60)) if duration and duration > 2 else None
    filler_total = sum(fillers.values())
    # 0-100 clarity heuristic: penalise fillers/hedges density, reward concrete numbers, sane length.
    density = (filler_total + 0.6 * sum(hedges.values())) / max(count, 1)
    clarity = 100 - min(55, density * 600)
    if count < 25:
        clarity -= 15
    elif count > 260:
        clarity -= 10
    if numbers:
        clarity += min(10, numbers * 4)
    if wpm and (wpm < 95 or wpm > 185):
        clarity -= 8
    return {
        "words": count,
        "sentences": len(sentences),
        "avgSentence": round(count / max(len(sentences), 1), 1),
        "fillers": fillers,
        "fillerCount": filler_total,
        "hedges": hedges,
        "numbers": numbers,
        "ownership": {"i": i, "we": we},
        "durationSec": round(duration, 1) if duration else None,
        "wpm": wpm,
        "clarity": int(max(0, min(100, round(clarity)))),
    }


_FILLER_ONLY = re.compile(
    r"\s*(no|nope|yes|yeah|yep|ok|okay|k|test|testing|lol|lmao|haha|hmm+|idk|dunno|asdf|qwerty|na|nah|nothing|.|\?+|\.+)[.!?\s]*",
    re.I,
)


def is_nonanswer(text: str) -> bool:
    """A reply too short or empty of content to count as an answer ('no', 'lol', 'test')."""
    words = re.findall(r"[A-Za-z0-9']+", text)
    return len(words) <= 2 or bool(_FILLER_ONLY.fullmatch(text))


def is_pass(text: str) -> bool:
    return bool(
        re.fullmatch(r"\s*(pass|skip|next|skip this|i don'?t know|no idea|not sure|idk)[.!\s]*", text, re.I)
    )

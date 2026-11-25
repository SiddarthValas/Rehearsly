"""Model client with two providers, chosen by environment:

  * Ollama (default, local and private): structured outputs via JSON schema in `format`.
  * Groq (hosted, used on Vercel): OpenAI-compatible API, json_schema response format,
    Whisper speech-to-text. Selected automatically when GROQ_API_KEY is set.

Both are called with the standard library only, so the serverless bundle stays small.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from typing import Iterator

PROVIDER = os.getenv("LLM_PROVIDER", "groq" if os.getenv("GROQ_API_KEY") else "ollama").lower()

# Ollama
BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.2")
EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))

# Groq
GROQ_URL = os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
GROQ_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_FAST_MODEL = os.getenv("GROQ_FAST_MODEL", "openai/gpt-oss-20b")
GROQ_WHISPER = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")
GROQ_PREFERENCE = [
    "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b",
]

DEFAULT_MODEL = GROQ_MODEL if PROVIDER == "groq" else OLLAMA_MODEL

# Backup providers (OpenAI-compatible), tried in order when Groq is rate-limited or down.
# Each is optional: set its key to switch it on.
BACKUPS = [
    provider for provider in [
        {
            "name": "Gemini",
            "url": os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai").rstrip("/"),
            "key": os.getenv("GEMINI_API_KEY", ""),
            "big": os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"),
            "fast": os.getenv("GEMINI_FAST_MODEL", os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")),
            "prefer": ["flash-lite", "flash"],
            "candidates": [],
        },
        {
            "name": "Mistral",
            "url": os.getenv("MISTRAL_BASE_URL", "https://api.mistral.ai/v1").rstrip("/"),
            "key": os.getenv("MISTRAL_API_KEY", ""),
            "big": os.getenv("MISTRAL_MODEL", "mistral-small-2603"),
            "fast": os.getenv("MISTRAL_FAST_MODEL", os.getenv("MISTRAL_MODEL", "mistral-small-2603")),
            "prefer": ["mistral-small", "ministral", "mistral-large"],
            # Tried in order when the account's plan refuses a model (free tiers cover only some).
            "candidates": ["mistral-small-2603", "mistral-small-latest", "ministral-8b-2512", "mistral-large-2512"],
        },
    ]
    if provider["key"]
]
_cooldown: dict[str, float] = {}  # provider name -> time it may be tried again
SERVED = {"name": "Groq" if PROVIDER == "groq" else "Ollama", "model": DEFAULT_MODEL, "at": 0.0}


class LLMError(RuntimeError):
    """Raised when the model cannot be reached or returns something unusable."""


_schema_ok: bool | None = None
_lock = threading.Lock()
_groq_models: list[str] | None = None
_groq_alias: dict[str, str] = {}


# --------------------------------------------------------------------------- http

def _service(url: str) -> str:
    """Human name of the service behind a URL, for error messages."""
    for provider in BACKUPS:
        if url.startswith(provider["url"]):
            return provider["name"]
    if url.startswith(GROQ_URL) or "groq" in url:
        return "Groq"
    return "Ollama" if url.startswith(BASE_URL) else "The AI service"


def _request(url: str, payload: dict | None = None, timeout: float = 180, headers: dict | None = None, data: bytes | None = None):
    body = data if data is not None else (json.dumps(payload).encode() if payload is not None else None)
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # Groq sits behind Cloudflare, which rejects Python's default "Python-urllib" agent (error 1010).
            "User-Agent": "Rehearsly/2.0 (+https://github.com/siddarth-valasubramanian/rehearsly)",
            **(headers or {}),
        },
        method="POST" if body is not None else "GET",
    )
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        text = error.read().decode(errors="ignore")
        try:
            parsed = json.loads(text)
            text = parsed.get("error", text)
            if isinstance(text, dict):
                text = text.get("message", json.dumps(text))
        except Exception:
            pass
        failure = LLMError(f"{_service(url)} returned {error.code}: {str(text)[:260]}")
        failure.status = error.code  # type: ignore[attr-defined]
        failure.retry_after = error.headers.get("retry-after") if error.headers else None  # type: ignore[attr-defined]
        raise failure from error
    except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
        if not url.startswith(BASE_URL):
            failure = LLMError(f"Can't reach {_service(url)} right now. Try again in a moment.")
            failure.status = 503  # type: ignore[attr-defined]  # an outage: let the next provider take over
            raise failure from error
        raise LLMError(f"Can't reach Ollama at {BASE_URL}. Start it with `ollama serve` and try again.") from error


def _repair_truncated(text: str):
    """Rescue a JSON object that was cut off mid-way (output token limit): keep every complete
    element and close the open brackets, so a long list loses only its unfinished last item."""
    start = text.find("{")
    if start == -1:
        return None
    body = text[start:]
    cut_points = [i for i, ch in enumerate(body) if ch in "}]"][::-1][:60]
    for cut in cut_points:
        candidate = body[: cut + 1]
        stack, in_string, escape = [], False, False
        for ch in candidate:
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch in "{[":
                stack.append(ch)
            elif ch in "}]":
                if stack:
                    stack.pop()
        if in_string:
            continue
        closing = "".join("}" if ch == "{" else "]" for ch in reversed(stack))
        try:
            value = json.loads(candidate + closing)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def extract_json(text: str):
    """Parse JSON, tolerating code fences or chatter around a single object."""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    repaired = _repair_truncated(text)
    if repaired is not None:
        return repaired
    start = text.find("{")
    while start != -1:
        depth, in_string, escape = 0, False, False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : index + 1])
                    except json.JSONDecodeError:
                        break
        start = text.find("{", start + 1)
    raise LLMError("The model did not return valid JSON.")


# --------------------------------------------------------------------------- groq

def _groq_headers() -> dict:
    if not GROQ_KEY:
        raise LLMError("GROQ_API_KEY is not set on the server.")
    return {"Authorization": f"Bearer {GROQ_KEY}"}


def _groq_available() -> list[str]:
    global _groq_models
    if _groq_models is None:
        with _request(GROQ_URL + "/models", headers=_groq_headers(), timeout=8) as response:
            data = json.loads(response.read().decode())
        _groq_models = [item.get("id", "") for item in data.get("data", []) if item.get("active", True)]
    return _groq_models


def _groq_model(requested: str) -> str:
    """Map a requested model to one that is actually live (models get retired)."""
    if requested in _groq_alias:
        return _groq_alias[requested]
    return requested


def _groq_fallback(requested: str) -> str:
    try:
        live = _groq_available()
    except LLMError:
        raise
    chat = [m for m in live if not re.search(r"whisper|guard|tts|orpheus|playai", m, re.I)]
    for candidate in GROQ_PREFERENCE:
        if candidate in chat and candidate != requested:
            _groq_alias[requested] = candidate
            return candidate
    if chat:
        _groq_alias[requested] = chat[0]
        return chat[0]
    raise LLMError("No chat model is available on this Groq account.")


def _groq_payload(messages: list[dict], model: str, temperature: float, max_tokens: int, stop=None, stream=False) -> dict:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_completion_tokens": max_tokens + (1000 if "gpt-oss" in model else 0),  # room for hidden reasoning (low effort)
        "stream": stream,
    }
    if "gpt-oss" in model:
        payload["reasoning_effort"] = "low"
        payload["include_reasoning"] = False
    if stop:
        payload["stop"] = stop[:4]
    return payload


def _groq_post(payload: dict, stream: bool = False):
    """POST with model fallback and polite retries on rate limits.

    Groq's free tier limits each model separately (per minute and per day), so a rate-limited
    model is swapped for the next live sibling straight away when the wait would be long, and
    every sibling gets a turn before giving up."""
    tried = {payload["model"]}
    daily = False
    for attempt in range(6):
        try:
            return _request(GROQ_URL + "/chat/completions", payload, headers=_groq_headers(), timeout=90)
        except LLMError as error:
            status = getattr(error, "status", None)
            text = str(error).lower()
            if status in (404, 400) and ("model" in text and ("not found" in text or "decommission" in text or "does not exist" in text)):
                payload["model"] = _groq_fallback(payload["model"])
                _fit_model(payload)
                continue
            if status in (413, 429):
                per_day = "per day" in text or "(tpd)" in text or "(rpd)" in text
                daily = daily or per_day
                try:
                    wait = float(getattr(error, "retry_after", None) or 0)
                except ValueError:
                    wait = 0.0
                sibling = _next_sibling(tried)
                if sibling and (per_day or status == 413 or wait > 4 or attempt >= 1):
                    tried.add(sibling)
                    payload["model"] = sibling
                    _fit_model(payload)
                    continue
                if not per_day and attempt < (1 if BACKUPS else 3):  # with backups, hand over instead of waiting
                    time.sleep(min(6.0, wait) if wait else 1.5 * (attempt + 1))
                    continue
                if daily:
                    raise LLMError("Today's free AI quota is used up. It resets within a day; a paid Groq key removes the limit.") from error
                raise LLMError("The AI is busy right now (rate limit). Wait a few seconds and try again.") from error
            raise
    raise LLMError("The hosted AI didn't respond. Try again.")


def _next_sibling(tried: set[str]) -> str | None:
    try:
        live = _groq_available()
    except LLMError:
        live = list(GROQ_PREFERENCE)
    return next((m for m in GROQ_PREFERENCE if m not in tried and m in live), None)


def _fit_model(payload: dict) -> None:
    """Reasoning options only apply to gpt-oss models."""
    if "gpt-oss" not in payload["model"]:
        payload.pop("reasoning_effort", None)
        payload.pop("include_reasoning", None)
    elif "reasoning_effort" not in payload:
        payload["reasoning_effort"] = "low"
        payload["include_reasoning"] = False


def _groq_chat(messages, model, temperature, max_tokens, schema):
    model = _groq_model(model)
    payload = _groq_payload(messages, model, temperature, max_tokens)
    if schema:
        payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}}
    try:
        with _groq_post(payload) as response:
            data = json.loads(response.read().decode())
    except LLMError as error:
        message = str(error).lower()
        if schema and getattr(error, "status", None) == 400 and ("response_format" in message or "json_schema" in message):
            # Model without structured outputs: JSON mode plus the schema in the prompt.
            payload["response_format"] = {"type": "json_object"}
            payload["messages"] = messages + [{"role": "user", "content": "Reply with only a JSON object matching this schema:\n" + json.dumps(schema)}]
            with _groq_post(payload) as response:
                data = json.loads(response.read().decode())
        else:
            raise
    content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return re.sub(r"<think>.*?</think>\s*", "", content, flags=re.S)  # fallback models may think out loud


def _groq_stream(messages, model, temperature, max_tokens, stop) -> Iterator[str]:
    payload = _groq_payload(messages, _groq_model(model), temperature, max_tokens, stop, stream=True)
    return _sse_tokens(_groq_post(payload, stream=True))


def transcribe(data: bytes, filename: str = "answer.wav") -> tuple[str, float]:
    """Hosted speech-to-text with Groq Whisper. Returns (text, duration seconds)."""
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("model", GROQ_WHISPER), ("response_format", "verbose_json"), ("language", "en"), ("temperature", "0")):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
        + data + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    headers = {**_groq_headers(), "Content-Type": f"multipart/form-data; boundary={boundary}"}
    with _request(GROQ_URL + "/audio/transcriptions", headers=headers, data=b"".join(parts), timeout=60) as response:
        result = json.loads(response.read().decode())
    return str(result.get("text", "")).strip(), float(result.get("duration") or 0)


# --------------------------------------------------------------------------- natural speech (Groq Orpheus)

TTS_MODEL = os.getenv("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english")
TTS_VOICES = ["hannah", "troy", "austin"]


def speak(text: str, voice: str = "hannah", direction: str = "") -> bytes:
    """Synthesize up to ~200 characters of speech. Returns WAV bytes."""
    if not GROQ_KEY:
        raise LLMError("Natural voice needs GROQ_API_KEY.")
    prefix = f"[{direction}] " if direction else ""
    text = prefix + " ".join(text.split())[: 200 - len(prefix)]  # the model's limit includes the direction tag
    payload = {"model": TTS_MODEL, "input": text, "voice": voice if voice in TTS_VOICES else "hannah", "response_format": "wav"}
    with _request(GROQ_URL + "/audio/speech", payload, headers=_groq_headers(), timeout=30) as response:
        return response.read()


# --------------------------------------------------------------------------- web search

SEARCH_MODEL = os.getenv("GROQ_SEARCH_MODEL", "openai/gpt-oss-20b")
_URL = re.compile(r"https?://[^\s\"'<>\\)\]】]+")


def can_search() -> bool:
    return bool(GROQ_KEY)


def web_search(prompt: str, max_tokens: int = 2048) -> tuple[str, list[dict]]:
    """Let the model browse the live web (Groq browser_search) and answer `prompt`.
    Keep prompts short and focused: long multi-site browsing sessions time out on Groq's side.
    Returns (answer text, sources [{url, title}])."""
    if not GROQ_KEY:
        raise LLMError("Live web search needs GROQ_API_KEY.")
    # Mirrors Groq's documented browser-search request, with low reasoning effort as they recommend.
    payload = {
        "model": SEARCH_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 1,
        "top_p": 1,
        "max_completion_tokens": max_tokens,
        "reasoning_effort": "low",
        "tools": [{"type": "browser_search"}],
        "tool_choice": "required",
        "stream": False,
    }
    response = None
    for attempt in range(2):
        try:
            response = _groq_post(payload)
            break
        except LLMError as error:
            status = getattr(error, "status", None)
            if status == 400 and "tool" in str(error).lower() and "tool_choice" in payload:
                payload.pop("tool_choice", None)  # model refused the forced tool call; let it decide
                continue
            if status and status >= 500 and attempt == 0:
                time.sleep(1.0)
                continue
            raise
    if response is None:
        raise LLMError("Web search didn't respond.")
    with response:
        data = json.loads(response.read().decode())
    message = (data.get("choices") or [{}])[0].get("message") or {}
    content = message.get("content") or ""
    tools_blob = json.dumps(message.get("executed_tools") or [], ensure_ascii=False)
    sources: list[dict] = []
    seen: set[str] = set()
    # Prefer structured search results when present, then any URL mentioned anywhere.
    for tool in message.get("executed_tools") or []:
        results = ((tool or {}).get("search_results") or {}).get("results") or []
        for item in results:
            url = str(item.get("url", "")).strip()
            if url and url not in seen:
                seen.add(url)
                sources.append({"url": url, "title": str(item.get("title", ""))[:160]})
    for url in _URL.findall(tools_blob + "\n" + content):
        url = url.rstrip(".,;")
        if url not in seen:
            seen.add(url)
            sources.append({"url": url, "title": ""})
    content = re.sub(r"【[^】]*】", "", content)  # strip inline citation markers
    return content.strip(), sources[:60]


# --------------------------------------------------------------------------- public API

# --------------------------------------------------------------------------- backup providers

def _capacity_error(error: Exception) -> bool:
    """Errors worth handing to the next provider: limits, outages and timeouts, not bad requests."""
    status = getattr(error, "status", None)
    text = str(error).lower()
    return status in (408, 413, 429, 500, 502, 503, 504, 529) or any(
        word in text for word in ("quota", "rate limit", "busy", "can't reach", "didn't respond", "timed out", "overloaded", "unavailable")
    )


def _cool(name: str, error: Exception) -> None:
    text = str(error).lower()
    daily = any(word in text for word in ("per day", "quota", "(tpd)", "(rpd)", "resource_exhausted"))
    _cooldown[name] = time.time() + (900 if daily else 25)


def _cooling(name: str) -> bool:
    return _cooldown.get(name, 0) > time.time()


def _is_fast(model: str | None) -> bool:
    return bool(model) and (model == GROQ_FAST_MODEL or "20b" in str(model))


def _discover(provider: dict) -> str | None:
    """Find a live model when the configured one has been renamed or retired."""
    try:
        with _request(provider["url"] + "/models", headers={"Authorization": f"Bearer {provider['key']}"}, timeout=8) as response:
            data = json.loads(response.read().decode())
    except LLMError:
        return None
    ids = [str(item.get("id", "")).removeprefix("models/") for item in data.get("data", [])]
    chat = [m for m in ids if not re.search(r"embed|tts|image|audio|vision|guard|moderation|aqa|imagen|veo|live", m, re.I)]
    for want in provider["prefer"]:
        hits = sorted((m for m in chat if want in m and "preview" not in m and "exp" not in m), reverse=True)
        if hits:
            return hits[0]
    return chat[0] if chat else None


def _backup_payload(provider: dict, messages, model: str, temperature, max_tokens, schema, stream=False, stop=None) -> dict:
    payload = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens + 400, "stream": stream}
    if stop:
        payload["stop"] = stop[:4]
    if schema:
        payload["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "schema": schema}}
    return payload


def _backup_open(provider: dict, messages, model, temperature, max_tokens, schema, stream=False, stop=None):
    """Open a request to one backup provider, fixing a stale model name or missing JSON-schema support once."""
    headers = {"Authorization": f"Bearer {provider['key']}"}
    payload = _backup_payload(provider, messages, model, temperature, max_tokens, schema, stream, stop)
    for _ in range(6):
        try:
            return _request(provider["url"] + "/chat/completions", payload, headers=headers, timeout=60)
        except LLMError as error:
            status = getattr(error, "status", None)
            text = str(error).lower()
            if status in (400, 404) and "model" in text and ("not found" in text or "does not exist" in text or "not supported" in text or "invalid model" in text):
                found = _discover(provider)
                if found and found != payload["model"]:
                    provider["big" if payload["model"] == provider["big"] else "fast"] = found
                    payload["model"] = found
                    continue
            if status == 403 and ("tier" in text or "not available" in text or "subscription" in text):
                # The plan doesn't include this model: move to the next candidate and remember it.
                tried = provider.setdefault("_refused", set())
                tried.add(payload["model"])
                nxt = next((m for m in provider.get("candidates", []) if m not in tried), None)
                if nxt:
                    provider["big"] = provider["fast"] = nxt
                    payload["model"] = nxt
                    continue
            if schema and status == 400 and ("response_format" in text or "json_schema" in text or "schema" in text):
                payload["response_format"] = {"type": "json_object"}
                payload["messages"] = messages + [{"role": "user", "content": "Reply with only a JSON object matching this schema:\n" + json.dumps(schema)}]
                continue
            raise
    raise LLMError(f"{provider['name']} didn't accept the request.")


def _sse_tokens(response) -> Iterator[str]:
    """Yield text deltas from an OpenAI-style event stream, hiding any <think> section."""
    thinking = False
    try:
        for raw in response:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                break
            item = json.loads(chunk)
            if item.get("error"):
                raise LLMError(str(item["error"]))
            delta = ((item.get("choices") or [{}])[0].get("delta") or {}).get("content")
            if delta and "<think>" in delta:
                thinking = True
                delta = delta.split("<think>")[0]
            if thinking and delta is not None and "</think>" in (delta or ""):
                thinking = False
                delta = delta.split("</think>", 1)[1].lstrip()
            elif thinking:
                continue
            if delta:
                yield delta
    finally:
        response.close()


def _order(prefer_backup: bool) -> list[str]:
    names = ["Groq"] + [p["name"] for p in BACKUPS]
    if prefer_backup and BACKUPS:
        names = [p["name"] for p in BACKUPS] + ["Groq"]
    ready = [n for n in names if not _cooling(n)]
    return ready or names  # if everyone is cooling down, try them all anyway


def _all_busy(last: Exception | None) -> LLMError:
    if BACKUPS and last is not None and _capacity_error(last):
        return LLMError("Every AI provider is busy or out of free quota right now. Try again in a few minutes.")
    return last if isinstance(last, LLMError) else LLMError("No AI provider is available right now.")


def _hosted_chat(messages, model, temperature, max_tokens, schema, prefer_backup=False) -> tuple[str, str]:
    """One completion through the provider chain. Returns (text, provider name)."""
    last: Exception | None = None
    for name in _order(prefer_backup):
        try:
            if name == "Groq":
                text = _groq_chat(messages, model or GROQ_MODEL, temperature, max_tokens, schema)
                served_model = model or GROQ_MODEL
            else:
                provider = next(p for p in BACKUPS if p["name"] == name)
                served_model = provider["fast" if _is_fast(model) else "big"]
                with _backup_open(provider, messages, served_model, temperature, max_tokens, schema) as response:
                    data = json.loads(response.read().decode())
                served_model = data.get("model") or provider["fast" if _is_fast(model) else "big"]
                text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                text = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.S)
            SERVED.update(name=name, model=served_model, at=time.time())
            return text, name
        except LLMError as error:
            last = error
            if not _capacity_error(error):
                raise
            _cool(name, error)
    raise _all_busy(last)


def _hosted_stream(messages, model, temperature, max_tokens, stop) -> Iterator[str]:
    last: Exception | None = None
    for name in _order(False):
        try:
            if name == "Groq":
                tokens = _groq_stream(messages, model or GROQ_FAST_MODEL, temperature, max_tokens, stop)
                served_model = model or GROQ_FAST_MODEL
            else:
                provider = next(p for p in BACKUPS if p["name"] == name)
                served_model = provider["fast" if _is_fast(model) else "big"]
                tokens = _sse_tokens(_backup_open(provider, messages, served_model, temperature, max_tokens, None, True, stop))
            first = next(tokens, None)  # errors surface here, before anything reached the user
        except LLMError as error:
            last = error
            if not BACKUPS or not _capacity_error(error):
                raise
            _cool(name, error)
            continue
        SERVED.update(name=name, model=served_model, at=time.time())
        if first:
            yield first
        yield from tokens
        return
    raise _all_busy(last)


_provider_check: dict = {"at": 0.0, "result": None}


def provider_check() -> list[dict]:
    """Send each configured provider a tiny request, so a bad key shows up before the day it's needed.
    Cached for a minute so the check itself can't burn quota."""
    if _provider_check["result"] is not None and time.time() - _provider_check["at"] < 60:
        return _provider_check["result"]
    ping = [{"role": "user", "content": "Reply with the single word: ready"}]
    results = []
    if PROVIDER == "groq":
        start = time.time()
        try:
            text = _groq_chat(ping, GROQ_FAST_MODEL, 0, 8, None)
            results.append({"name": "Groq", "ok": True, "model": GROQ_FAST_MODEL, "ms": round((time.time() - start) * 1000), "reply": text.strip()[:20]})
        except LLMError as error:
            results.append({"name": "Groq", "ok": False, "model": GROQ_FAST_MODEL, "error": str(error)[:160]})
    for provider in BACKUPS:
        start = time.time()
        try:
            with _backup_open(provider, ping, provider["fast"], 0, 8, None) as response:
                data = json.loads(response.read().decode())
            text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
            results.append({"name": provider["name"], "ok": True, "model": data.get("model") or provider["fast"], "ms": round((time.time() - start) * 1000), "reply": text.strip()[:20]})
        except LLMError as error:
            results.append({"name": provider["name"], "ok": False, "model": provider["fast"], "error": str(error)[:160]})
    _provider_check.update(at=time.time(), result=results)
    return results


def fast_model(model: str | None) -> str | None:
    """The lighter model used for per-turn work (questions, grading, hints)."""
    if PROVIDER == "groq":
        return GROQ_FAST_MODEL
    return model


def chat(messages: list[dict], *, model: str | None = None, temperature: float = 0.4, max_tokens: int = 400, schema: dict | None = None, prefer_backup: bool = False, meta: dict | None = None):
    """One non-streaming call. Returns a dict when `schema` is given, else text.
    prefer_backup asks a backup provider first (used for the independent second grader)."""
    global _schema_ok
    if PROVIDER == "groq":
        attempts = 2 if schema else 1
        last: Exception | None = None
        for _ in range(attempts):
            content, served = _hosted_chat(messages, model or GROQ_MODEL, temperature, max_tokens, schema, prefer_backup)
            if meta is not None:
                meta["provider"] = served
            if not schema:
                return content.strip()
            try:
                return extract_json(content)
            except LLMError as error:
                last = error
        raise LLMError(str(last))

    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": NUM_CTX},
    }
    attempts = 2 if schema else 1
    last_error: Exception | None = None
    for _ in range(attempts):
        if schema:
            payload["format"] = schema if _schema_ok is not False else "json"
        try:
            with _request(BASE_URL + "/api/chat", payload) as response:
                data = json.loads(response.read().decode())
        except LLMError as error:
            if schema and _schema_ok is None and "format" in str(error).lower():
                with _lock:
                    _schema_ok = False
                last_error = error
                continue
            raise
        if schema and _schema_ok is None and payload.get("format") != "json":
            _schema_ok = True
        content = (data.get("message") or {}).get("content", "")
        if not schema:
            return content.strip()
        try:
            return extract_json(content)
        except LLMError as error:
            last_error = error
            payload["options"]["temperature"] = max(0.1, temperature - 0.2)
    raise LLMError(str(last_error) if last_error else "The model returned nothing usable.")


def stream(messages: list[dict], *, model: str | None = None, temperature: float = 0.5, max_tokens: int = 200, stop: list[str] | None = None) -> Iterator[str]:
    """Yield text chunks as the model produces them. Closing the generator stops generation."""
    if PROVIDER == "groq":
        yield from _hosted_stream(messages, model or GROQ_FAST_MODEL, temperature, max_tokens, stop)
        return
    payload = {
        "model": model or OLLAMA_MODEL,
        "messages": messages,
        "stream": True,
        "keep_alive": KEEP_ALIVE,
        "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": NUM_CTX, **({"stop": stop} if stop else {})},
    }
    response = _request(BASE_URL + "/api/chat", payload)
    try:
        for raw in response:
            line = raw.decode().strip()
            if not line:
                continue
            item = json.loads(line)
            if item.get("error"):
                raise LLMError(str(item["error"]))
            chunk = (item.get("message") or {}).get("content", "")
            if chunk:
                yield chunk
            if item.get("done"):
                break
    finally:
        response.close()


def embed(texts: list[str]) -> list[list[float]] | None:
    """Local embeddings (Ollama only). Hosted mode returns None and retrieval uses BM25."""
    if PROVIDER == "groq" or not texts:
        return None if texts else []
    try:
        with _request(BASE_URL + "/api/embed", {"model": EMBED_MODEL, "input": texts, "keep_alive": KEEP_ALIVE}, timeout=60) as response:
            data = json.loads(response.read().decode())
        vectors = data.get("embeddings")
        if vectors and len(vectors) == len(texts):
            return vectors
    except LLMError:
        pass
    try:
        vectors = []
        for text in texts:
            with _request(BASE_URL + "/api/embeddings", {"model": EMBED_MODEL, "prompt": text}, timeout=60) as response:
                vectors.append(json.loads(response.read().decode())["embedding"])
        return vectors
    except Exception:
        return None


def status() -> dict:
    if PROVIDER == "groq":
        try:
            live = _groq_available()
        except LLMError as error:
            if BACKUPS:
                return {"ok": True, "provider": "groq", "model": BACKUPS[0]["big"], "models": [], "embeddings": False, "error": "",
                        "backups": [p["name"] for p in BACKUPS], "served": BACKUPS[0]["name"]}
            return {"ok": False, "provider": "groq", "model": GROQ_MODEL, "models": [], "embeddings": False, "error": str(error)}
        model = GROQ_MODEL if GROQ_MODEL in live else _groq_alias.get(GROQ_MODEL) or (GROQ_MODEL if not live else _groq_fallback(GROQ_MODEL))
        return {"ok": True, "provider": "groq", "model": model, "models": [], "embeddings": False, "error": "",
                "backups": [p["name"] for p in BACKUPS], "served": SERVED["name"] if time.time() - SERVED["at"] < 600 else "Groq"}
    try:
        with _request(BASE_URL + "/api/tags", timeout=2.5) as response:
            payload = json.loads(response.read().decode())
    except LLMError as error:
        return {"ok": False, "provider": "ollama", "model": OLLAMA_MODEL, "models": [], "embeddings": False, "error": str(error)}
    names = sorted(item.get("name", "") for item in payload.get("models", []))
    chat_models = [name for name in names if "embed" not in name.lower()]

    def has(target: str) -> bool:
        base = target.split(":")[0]
        return any(name == target or name.split(":")[0] == base for name in names)

    ready = has(OLLAMA_MODEL) or bool(chat_models)
    return {
        "ok": ready,
        "provider": "ollama",
        "model": OLLAMA_MODEL if has(OLLAMA_MODEL) else (chat_models[0] if chat_models else OLLAMA_MODEL),
        "models": chat_models,
        "embeddings": has(EMBED_MODEL),
        "embedModel": EMBED_MODEL,
        "error": "" if ready else f"No chat model installed. Run `ollama pull {OLLAMA_MODEL}`.",
    }


def warm(model: str | None = None) -> None:
    if PROVIDER == "groq":
        return
    try:
        with _request(BASE_URL + "/api/chat", {"model": model or OLLAMA_MODEL, "messages": [], "keep_alive": KEEP_ALIVE}, timeout=120):
            pass
    except Exception:
        pass

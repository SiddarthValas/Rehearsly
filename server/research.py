"""Live company research on the open web (Groq browser search):

  * company_brief: values, culture, news and interview style, used to ground HR interviews.
  * question_bank: questions candidates report being asked at a company, gathered from
    Glassdoor, Reddit, LeetCode Discuss, GeeksforGeeks, AmbitionBox, Quora and blogs,
    grouped by subject and dated, each linked to its source.

Without a Groq key it falls back to the model's own knowledge and says so plainly.
"""

from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from server import llm

CACHE_TTL = 6 * 3600
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()

SUBJECTS = [
    "Behavioral & HR", "Coding & DSA", "SQL & databases", "Machine learning", "Statistics & probability",
    "System design", "Product & case", "Projects & resume", "Company & role", "Aptitude & puzzles",
]

BANK_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "rounds": {"type": "array", "items": {"type": "string"}},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "subject": {"type": "string"},
                    "round": {"type": "string"},
                    "date": {"type": "string"},
                    "source": {"type": "string"},
                    "url": {"type": "string"},
                },
                "required": ["question", "subject", "round", "date", "source", "url"],
            },
        },
    },
    "required": ["summary", "rounds", "questions"],
}

BANK_SCHEMA_SCOPED = {
    **BANK_SCHEMA,
    "properties": {
        **BANK_SCHEMA["properties"],
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    **BANK_SCHEMA["properties"]["questions"]["items"]["properties"],
                    "scope": {"type": "string", "enum": ["exact", "company", "similar"]},
                },
                "required": ["question", "subject", "round", "date", "source", "url", "scope"],
            },
        },
    },
}

BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "overview": {"type": "string"},
        "values": {"type": "array", "items": {"type": "string"}},
        "culture": {"type": "array", "items": {"type": "string"}},
        "news": {"type": "array", "items": {"type": "string"}},
        "products": {"type": "array", "items": {"type": "string"}},
        "hr_focus": {"type": "array", "items": {"type": "string"}},
        "sample_questions": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["overview", "values", "culture", "news", "products", "hr_focus", "sample_questions"],
}


def _key(*parts: str) -> str:
    return "|".join(" ".join(p.lower().split()) for p in parts)


def _cached(key: str):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    return None


def _store(key: str, value: dict) -> dict:
    with _lock:
        if len(_cache) > 300:
            _cache.clear()
        _cache[key] = (time.time(), value)
    return value


def _site(url: str) -> str:
    host = urlparse(url).netloc.lower().removeprefix("www.")
    names = {
        "glassdoor": "Glassdoor", "reddit": "Reddit", "leetcode": "LeetCode", "geeksforgeeks": "GeeksforGeeks",
        "ambitionbox": "AmbitionBox", "quora": "Quora", "medium": "Medium", "teamblind": "Blind", "indeed": "Indeed",
        "linkedin": "LinkedIn", "interviewbit": "InterviewBit", "prepinsta": "PrepInsta", "youtube": "YouTube",
    }
    for needle, name in names.items():
        if needle in host:
            return name
    return host or "Web"


def _norm_date(value: str) -> str:
    value = (value or "").strip()
    match = re.search(r"(20\d\d)(?:[-/\s](\d{1,2}))?", value)
    if match:
        year, month = match.group(1), match.group(2)
        if month and 1 <= int(month) <= 12:
            return f"{year}-{int(month):02d}"
        months = "jan feb mar apr may jun jul aug sep oct nov dec".split()
        word = re.search(r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", value, re.I)
        if word:
            return f"{year}-{months.index(word.group(1).lower()[:3]) + 1:02d}"
        return year
    return ""


def _similar(a: str, b: str) -> bool:
    wa = {w for w in re.findall(r"[a-z0-9]+", a.lower()) if len(w) > 2}
    wb = {w for w in re.findall(r"[a-z0-9]+", b.lower()) if len(w) > 2}
    return bool(wa and wb) and len(wa & wb) / len(wa | wb) > 0.6


def _match_url(url: str, sources: list[dict]) -> str:
    """Only keep URLs the search actually visited (or a page on the same site)."""
    url = (url or "").strip().rstrip(".,;")
    if not url.startswith("http"):
        return ""
    found = [s["url"] for s in sources]
    if url in found:
        return url
    for candidate in found:
        if candidate.rstrip("/") == url.rstrip("/") or candidate.startswith(url) or url.startswith(candidate):
            return candidate
    return ""


# --------------------------------------------------------------------------- question bank

# Three short, focused searches run in parallel: one long multi-site browse times out on Groq.
_SITE_GROUPS = [
    ("Glassdoor and AmbitionBox", "glassdoor.com OR ambitionbox.com"),
    ("Reddit and Blind", "reddit.com OR teamblind.com"),
    ("LeetCode Discuss and GeeksforGeeks", "leetcode.com/discuss OR geeksforgeeks.org"),
]


def _focused_prompt(company: str, role: str, sites: str, hint: str) -> str:
    target = f"{company} {role}".strip()
    return f"""Search {sites} ({hint}) for "{target} interview questions" and interview experiences from the last 3 years.
List 8 to 15 real questions candidates reported, one per line, as:
QUESTION | TOPIC | ROUND | DATE (year or month-year, or unknown) | SITE | URL
Only questions you actually found. No invented ones."""


def _bank_search_prompt(company: str, role: str) -> str:
    target = f"the {role} role at {company}" if role else f"{company}"
    return f"""Research real interview questions that candidates report being asked for {target}.

Search several sources, one after another: Glassdoor interview reviews, Reddit (r/cscareerquestions, r/developersIndia, r/datascience and similar), LeetCode Discuss interview experiences, GeeksforGeeks interview experiences, AmbitionBox, Quora, Blind and personal blog posts. Prefer the last 3 years.

Then write a plain list of 25 to 40 distinct questions you actually found. For each line give:
QUESTION | TOPIC | ROUND (online assessment, technical, managerial, HR) | DATE of that interview (year or month-year, or unknown) | SOURCE SITE | URL

Only include questions that appear in what you found. Do not invent questions. After the list, write two sentences describing the usual interview process (rounds) for this role."""


def _bank_structure_prompt(company: str, role: str, notes: str, sources: list[dict]) -> str:
    urls = "\n".join(f"- {s['url']}" for s in sources[:25])
    return f"""Organise these research notes about interview questions at {company}{' for ' + role if role else ''}.

Rules:
- Keep only real questions present in the notes. Rewrite each as one clear question. Remove duplicates.
- subject: one of {", ".join(SUBJECTS)}
- round: short label like "Online assessment", "Technical 1", "Managerial", "HR"
- date: "YYYY-MM", "YYYY" or "" if unknown
- source: the site name (Glassdoor, Reddit, LeetCode...)
- url: copy the exact URL from the notes or the list below, or "" if none
- summary: two sentences on the interview process
- rounds: the rounds in order

Notes:
{notes[:7000]}

URLs that were visited:
{urls}"""


# --------------------------------------------------------------------------- company name resolution

# Common employers for typo-tolerant matching (difflib), checked before any AI call.
KNOWN_COMPANIES = [
    "Google", "Microsoft", "Amazon", "Meta", "Apple", "Netflix", "Adobe", "Salesforce", "Oracle", "IBM", "Intel", "Nvidia",
    "Cisco", "Qualcomm", "SAP", "Uber", "Airbnb", "LinkedIn", "Atlassian", "Intuit", "PayPal", "Visa", "Mastercard",
    "Goldman Sachs", "JPMorgan Chase", "Morgan Stanley", "American Express", "Deutsche Bank", "Barclays", "HSBC", "Citi",
    "Walmart", "Walmart Global Tech", "Target", "Flipkart", "Myntra", "Meesho", "Swiggy", "Zomato", "Blinkit", "Zepto",
    "Paytm", "PhonePe", "Razorpay", "CRED", "Groww", "Zerodha", "Ola", "Rapido", "Dream11", "MakeMyTrip", "Nykaa",
    "BYJU'S", "Unacademy", "Freshworks", "Zoho", "InMobi", "ShareChat", "Postman", "BrowserStack", "Juspay",
    "Tata Consultancy Services", "Infosys", "Wipro", "HCLTech", "Tech Mahindra", "Cognizant", "Accenture", "Capgemini",
    "Deloitte", "PwC", "EY", "KPMG", "LTIMindtree", "Mphasis", "Persistent Systems", "Hexaware", "Coforge", "Zensar",
    "Larsen & Toubro", "Reliance Industries", "Reliance Jio", "Tata Motors", "Mahindra & Mahindra", "Mercedes-Benz",
    "Bosch", "Siemens", "Honeywell", "Shell", "ExxonMobil", "Worley", "Schlumberger", "Fractal Analytics",
    "Mu Sigma", "Tiger Analytics", "LatentView Analytics", "ZS Associates", "McKinsey & Company", "Boston Consulting Group",
    "Bain & Company", "Samsung", "Samsung R&D", "Sony", "Dell", "HP", "Texas Instruments", "AMD", "Arista Networks",
    "VMware", "ServiceNow", "Snowflake", "Databricks", "Stripe", "Spotify", "Twitter", "X", "Expedia", "Booking.com",
]
ABBREVIATIONS = {
    "tcs": "Tata Consultancy Services", "hcl": "HCLTech", "l&t": "Larsen & Toubro", "lnt": "Larsen & Toubro",
    "jpmc": "JPMorgan Chase", "jp morgan": "JPMorgan Chase", "gs": "Goldman Sachs", "ms": "Microsoft", "bcg": "Boston Consulting Group",
    "ltim": "LTIMindtree", "amex": "American Express", "ril": "Reliance Industries", "m&m": "Mahindra & Mahindra", "fb": "Meta",
    "facebook": "Meta", "aws": "Amazon", "techm": "Tech Mahindra", "zs": "ZS Associates",
}

RESOLVE_SCHEMA = {
    "type": "object",
    "properties": {
        "company": {"type": "string"},
        "program": {"type": "string"},
        "aliases": {"type": "array", "items": {"type": "string"}},
        "roles": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["company", "program", "aliases", "roles"],
}


def _fuzzy_company(text: str) -> tuple[str, str]:
    """Split 'tech mahindra digital catalyst' into ('Tech Mahindra', 'digital catalyst') using
    the longest known company name that fuzzily matches the start of the input."""
    import difflib

    lowered = " ".join(text.lower().split())
    if lowered in ABBREVIATIONS:
        return ABBREVIATIONS[lowered], ""
    words = lowered.split()
    for size in range(min(5, len(words)), 0, -1):
        head, rest = " ".join(words[:size]), " ".join(words[size:])
        if head in ABBREVIATIONS:
            return ABBREVIATIONS[head], rest
        names = {name.lower(): name for name in KNOWN_COMPANIES}
        match = difflib.get_close_matches(head, list(names), n=1, cutoff=0.84 if size > 1 else 0.9)
        if match:
            return names[match[0]], rest
    return "", ""


def resolve_company(company: str, role: str) -> dict:
    """Work out the canonical company, any programme/team name, aliases and role variants."""
    key = _key("resolve", company, role)
    if hit := _cached(key):
        return hit
    known, rest = _fuzzy_company(company)
    resolved = {"company": known or company, "program": rest.title() if rest else "", "aliases": [], "roles": [role] if role else []}
    try:
        raw = llm.chat(
            [{"role": "user", "content": f"""A job seeker typed this company: "{company}" and this role: "{role or 'any'}".
Return:
- company: the employer's official, commonly used name (fix typos; if it's a division, programme or team, give the parent company)
- program: the specific division, programme, team or hiring track they typed, or "" if none
- aliases: up to 4 other names people use for this employer or programme online
- roles: up to 3 common job titles this maps to (include the typed role if any)"""}],
            model=llm.fast_model(None), temperature=0.1, max_tokens=300, schema=RESOLVE_SCHEMA,
        )
        typed_words = {w for w in re.findall(r"[a-z0-9&]+", company.lower()) if len(w) > 1}

        def plausible(value: str, limit: int = 60) -> str:
            value = " ".join(str(value).split()).strip(" .,'\"")
            if not value or len(value) > limit or re.search(r"[:\"{}\[\]]", value) or len(value.split()) > 6:
                return ""
            return value

        name = plausible(raw.get("company", ""), 70)
        # Only accept the AI's name if it overlaps with what was typed (or fixes a known typo).
        if not known and name and ({w for w in re.findall(r"[a-z0-9&]+", name.lower())} & typed_words or _similar(name, company)):
            resolved["company"] = name
        program = plausible(raw.get("program", ""))
        if not rest and program and {w for w in re.findall(r"[a-z0-9&]+", program.lower()) if len(w) > 1} <= typed_words and program.lower() not in resolved["company"].lower():
            resolved["program"] = program  # the programme must come from what they typed, never invented
        aliases = [plausible(x, 40) for x in raw.get("aliases") or []]
        resolved["aliases"] = [a for a in dict.fromkeys(aliases) if a and a.lower() != resolved["company"].lower()][:4]
        roles = [plausible(x, 50) for x in raw.get("roles") or []]
        resolved["roles"] = list(dict.fromkeys(([role] if role else []) + [r for r in roles if r]))[:3]
    except Exception:
        pass
    return _store(key, resolved)


# --------------------------------------------------------------------------- question bank

def _tier_prompt(target: str, role: str, sites: str, hint: str, aliases: list[str], broad: bool) -> str:
    alias_text = f' (also known as {", ".join(aliases)})' if aliases else ""
    scope = (
        f"interview questions asked at {target}{alias_text} for any technical or graduate role"
        if broad else f'"{target}"{alias_text} {role} interview questions and interview experiences'
    )
    return f"""Search {sites} ({hint}) for {scope}, from the last 3 years. Try a couple of different search phrasings.
List up to 15 real questions candidates reported, one per line, as:
QUESTION | TOPIC | ROUND | DATE (year or month-year, or unknown) | SITE | URL
Only questions you actually found. No invented ones. If you find none, say NONE."""


def _run_searches(prompts: list[tuple[str, str]]) -> tuple[str, list[dict], int]:
    notes, sources, ok = "", [], 0
    with ThreadPoolExecutor(max_workers=len(prompts)) as pool:
        jobs = [(label, pool.submit(llm.web_search, prompt)) for label, prompt in prompts]
        for label, job in jobs:
            try:
                text, urls = job.result(timeout=75)
            except Exception:
                continue
            ok += 1
            notes += f"\n\n[{label}]\n{text}"
            seen = {s["url"] for s in sources}
            sources += [u for u in urls if u["url"] not in seen]
    return notes, sources, ok


def _find_questions(raw) -> list:
    """The question list, wherever a model put it: top level, wrapped in another object, or under another name."""
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict) and x.get("question")]
    if not isinstance(raw, dict):
        return []
    if isinstance(raw.get("questions"), list) and raw["questions"]:
        return raw["questions"]
    if raw.get("question"):  # a single question object
        return [raw]
    for value in raw.values():
        found = _find_questions(value)
        if found:
            return found
    return []


LAST_DEBUG: list[dict] = []


def _structure(company: str, program: str, role: str, notes: str, sources: list[dict], live: bool) -> tuple[list[dict], dict]:
    target = f"{company} {program}".strip()
    raw = llm.chat(
        [{"role": "user", "content": _bank_structure_prompt(target, role, notes, sources) + f"""

Each note block is labelled [exact], [company] or [similar]. Set scope from the block a question came from:
"exact" = asked for {target}{' ' + role if role else ''}; "company" = asked at {company} for other teams or roles; "similar" = asked at comparable companies.
Keep questions from every block; do not drop [company] or [similar] ones. Return at most 18 questions, best first."""}],
        temperature=0.1, max_tokens=2800, schema=BANK_SCHEMA_SCOPED,
    )
    LAST_DEBUG.append({"pass": "first", "by": llm.SERVED.get("name"), "keys": list(raw)[:6] if isinstance(raw, dict) else type(raw).__name__, "found": len(_find_questions(raw)), "notes": len(notes)})
    if not _find_questions(raw):
        try:
            raw = llm.chat(
                [{"role": "user", "content": _bank_structure_prompt(target, role, notes[:6000], sources) + "\n\nReturn at most 12 questions."}],
                model=llm.fast_model(None), temperature=0.1, max_tokens=3000, schema=BANK_SCHEMA_SCOPED,
            )
            LAST_DEBUG.append({"pass": "retry", "by": llm.SERVED.get("name"), "keys": list(raw)[:6] if isinstance(raw, dict) else type(raw).__name__, "found": len(_find_questions(raw))})
        except llm.LLMError as error:
            LAST_DEBUG.append({"pass": "retry", "error": str(error)[:200]})
    if not isinstance(raw, dict):
        raw = {"questions": _find_questions(raw)}
    items: list[dict] = []
    for item in _find_questions(raw):
        if not isinstance(item, dict):
            continue
        question = " ".join(str(item.get("question", "")).split()).strip()
        if len(question) < 8 or question.upper() == "NONE" or any(_similar(question, kept["question"]) for kept in items):
            continue
        if not question.endswith("?") and not re.match(r"(design|implement|write|explain|describe|tell|walk|find|given|how|what|why)\b", question, re.I):
            question = question.rstrip(".") + "?"
        subject = str(item.get("subject", "")).strip()
        subject = next((s for s in SUBJECTS if s.lower() == subject.lower()), None) or next(
            (s for s in SUBJECTS if subject and subject.lower().split()[0] in s.lower()), "Company & role"
        )
        url = _match_url(str(item.get("url", "")), sources) if live else ""
        scope = str(item.get("scope", "exact")).lower()
        items.append({
            "id": f"q{len(items) + 1}",
            "question": question[:400],
            "subject": subject,
            "round": " ".join(str(item.get("round", "")).split())[:40],
            "date": _norm_date(str(item.get("date", ""))),
            "source": _site(url) if url else " ".join(str(item.get("source", "")).split())[:40],
            "url": url,
            "scope": scope if scope in ("exact", "company", "similar") else "exact",
        })
    return items, raw


def question_bank(company: str, role: str = "", refresh: bool = False):
    """Yield progress events, ending with {"type": "bank", "bank": {...}}.

    1. Resolve the name (typo-tolerant match + AI) into company, programme and aliases.
    2. Search the exact target on three site groups in parallel.
    3. Too few results? Widen to the whole company (and then similar companies), tagging each question's scope.
    4. Nothing at all? Fall back to the model's own knowledge, clearly labelled. Never an empty error.
    """
    typed = " ".join(company.split())[:80]
    role = " ".join(role.split())[:80]
    if len(typed) < 2:
        raise ValueError("Enter a company name.")
    key = _key("bank", typed, role)
    if not refresh and (hit := _cached(key)):
        yield {"type": "stage", "label": "Loaded recent results"}
        yield {"type": "bank", "bank": hit}
        return

    LAST_DEBUG.clear()
    resolved = resolve_company(typed, role)
    name, program, aliases = resolved["company"], resolved["program"], resolved["aliases"]
    target = f"{name} {program}".strip()
    if target.lower() != typed.lower():
        yield {"type": "stage", "label": f"Understood as {name}" + (f", {program}" if program else "")}

    live = llm.can_search()
    notes, sources, items, raw = "", [], [], {}
    if live:
        yield {"type": "stage", "label": f"Searching Glassdoor, Reddit, LeetCode and more for {target}", "pending": True}
        prompts = [("exact", _tier_prompt(target, role, label, hint, aliases, False)) for label, hint in _SITE_GROUPS]
        if program:  # search the parent company at the same time: candidates rarely name the programme
            prompts.append(("company", _tier_prompt(name, role, "Glassdoor, AmbitionBox and Reddit", "glassdoor.com OR ambitionbox.com OR reddit.com", aliases, True)))
        notes, sources, ok = _run_searches(prompts)
        if ok:
            yield {"type": "stage", "label": f"Read {len(sources)} pages"}
            yield {"type": "stage", "label": "Grouping questions by subject and date", "pending": True}
            items, raw = _structure(name, program, role, notes, sources, True)
        if len(items) < 6:
            yield {"type": "stage", "label": f"Only {len(items)} found, widening to all {name} interviews and similar roles", "pending": True}
            more_notes, more_sources, ok2 = _run_searches([
                ("company", _tier_prompt(name, role, "Glassdoor and AmbitionBox", "glassdoor.com OR ambitionbox.com", aliases, True)),
                ("company", _tier_prompt(name, role, "Reddit, GeeksforGeeks and LeetCode Discuss", "reddit.com OR geeksforgeeks.org OR leetcode.com/discuss", aliases, True)),
                ("similar", f"""Search GeeksforGeeks, Glassdoor and Reddit for interview questions asked for {role or 'graduate and entry-level tech'} roles at companies similar to {name}, from the last 3 years.
List up to 12 real questions, one per line, as: QUESTION | TOPIC | ROUND | DATE | SITE | URL"""),
            ])
            if ok2:
                notes += more_notes
                sources += [u for u in more_sources if u["url"] not in {s["url"] for s in sources}]
                items, raw = _structure(name, program, role, notes, sources, True)
        if not items:
            live = False
    if not live:
        yield {"type": "stage", "label": "Using the model's own knowledge (live results weren't available)", "pending": True}
        try:
            fallback = llm.chat(
                [{"role": "user", "content": _bank_search_prompt(target, role) + "\n\n(You cannot browse. Use only what you reliably know about this company's interviews, and leave URL empty.)"}],
                temperature=0.3, max_tokens=1800,
            )
        except llm.LLMError as error:
            LAST_DEBUG.append({"pass": "knowledge", "error": str(error)[:200]})
            fallback = ""
        LAST_DEBUG.append({"pass": "knowledge", "by": llm.SERVED.get("name"), "chars": len(fallback), "head": fallback[:160]})
        items, raw = _structure(name, program, role, "[exact]\n" + fallback, [], False)
    yield {"type": "debug", "structure": LAST_DEBUG[-6:]}
    if not items:
        raise ValueError(f"Couldn't find questions for {typed}. Try the company's full name.")

    groups: dict[str, list[dict]] = {}
    for item in items:
        groups.setdefault(item["subject"], []).append(item)
    rank = {"exact": 0, "company": 1, "similar": 2}
    ordered = []
    for subject in sorted(groups, key=lambda s: (-len(groups[s]), SUBJECTS.index(s) if s in SUBJECTS else 99)):
        questions = sorted(groups[subject], key=lambda q: (rank.get(q["scope"], 0), -(int(re.sub(r"\D", "", q["date"] or "0") or 0))))
        ordered.append({"subject": subject, "questions": questions})
    bank = {
        "company": typed,
        "role": role,
        "resolved": {"company": name, "program": program, "aliases": aliases},
        "live": live,
        "summary": " ".join(str(raw.get("summary", "")).split())[:600],
        "rounds": [" ".join(str(r).split())[:40] for r in (raw.get("rounds") or []) if str(r).strip()][:8],
        "groups": ordered,
        "count": len(items),
        "scopes": {s: sum(1 for i in items if i["scope"] == s) for s in ("exact", "company", "similar")},
        "sources": [{"url": s["url"], "site": _site(s["url"]), "title": s.get("title", "")} for s in sources[:25]],
        "fetchedAt": time.time(),
    }
    yield {"type": "bank", "bank": _store(key, bank)}


# --------------------------------------------------------------------------- company brief (HR mode)

def company_brief(company: str, role: str = "") -> dict:
    company = " ".join(company.split())[:80]
    key = _key("brief", company, role)
    if hit := _cached(key):
        return hit
    prompt = f"""Research {company} for a candidate preparing for an HR / culture-fit interview{' for a ' + role + ' role' if role else ''}.
Find: what the company does, its stated mission and values (with their exact names), culture and ways of working,
notable news from the last 12 months, key products, and what its HR and behavioral interviews focus on, including
questions candidates report being asked in HR rounds there."""
    live = llm.can_search()
    notes, sources = "", []
    if live:
        focused = [
            f"Search for {company}'s mission, core values (exact names), culture and its most notable news from the last 12 months. Summarise in short bullet points with source URLs.",
            f"Search Glassdoor, AmbitionBox and Reddit for HR and behavioural interview questions candidates were asked at {company}{' for ' + role if role else ''}. List up to 12 with source URLs.",
        ]
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(llm.web_search, item) for item in focused]
            for job in jobs:
                try:
                    text, urls = job.result(timeout=75)
                except Exception:
                    continue
                notes += "\n\n" + text
                sources += [u for u in urls if u["url"] not in {s["url"] for s in sources}]
        live = bool(notes.strip())
    if not live:
        notes = llm.chat([{"role": "user", "content": prompt + "\n(You cannot browse; use only what you reliably know.)"}], temperature=0.3, max_tokens=1400)
        sources = []
    raw = llm.chat(
        [{"role": "user", "content": f"Summarise these research notes about {company}. Copy specific names and facts; no invented ones.\n\n{notes[:10000]}"}],
        temperature=0.1, max_tokens=1600, schema=BRIEF_SCHEMA,
    )

    def clean(values, limit):
        out = []
        for value in values or []:
            value = " ".join(str(value).split()).strip(" -•")
            if value and value not in out:
                out.append(value[:220])
        return out[:limit]

    brief = {
        "company": company,
        "live": live,
        "overview": " ".join(str(raw.get("overview", "")).split())[:700],
        "values": clean(raw.get("values"), 8),
        "culture": clean(raw.get("culture"), 6),
        "news": clean(raw.get("news"), 5),
        "products": clean(raw.get("products"), 6),
        "hrFocus": clean(raw.get("hr_focus"), 6),
        "questions": clean(raw.get("sample_questions"), 10),
        "sources": [{"url": s["url"], "site": _site(s["url"])} for s in sources[:12]],
    }
    return _store(key, brief)


def brief_text(brief: dict) -> str:
    """Flatten a brief into plain lines so topics can be grounded in it."""
    lines = [f"{brief['company']}: {brief['overview']}"]
    for label, key in (("Value", "values"), ("Culture", "culture"), ("News", "news"), ("Product", "products"), ("HR focus", "hrFocus"), ("Reported HR question", "questions")):
        lines += [f"{label}: {item}" for item in brief.get(key, [])]
    return "\n".join(lines)

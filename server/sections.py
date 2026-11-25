"""Split a resume into its sections (projects, experience, skills...) so the interview
can be restricted to the parts the candidate wants to practise."""

from __future__ import annotations

import re

AREAS = {
    "projects": r"(academic |personal |key |major |selected |technical )?projects?( undertaken| work)?",
    "experience": r"(work |professional |industry |relevant )?(experience|internships?|employment|work history)( & internships| and internships)?",
    "skills": r"(technical |core |key )?(skills|technologies|tools|tech stack|competencies|skill set)( & tools| and tools)?",
    "education": r"education|academics?|academic background|(relevant )?coursework|qualifications",
    "achievements": r"achievements|awards|honou?rs|accomplishments|certifications?|hackathons?|awards & achievements|achievements & certifications",
    "leadership": r"leadership|extra[- ]?curricular( activities)?|positions? of responsibility|activities|volunteer(ing)?|clubs|co[- ]?curricular",
}

AREA_LABELS = {
    "projects": "projects",
    "experience": "internships and work experience",
    "skills": "technical skills and tools",
    "education": "education and coursework",
    "achievements": "achievements, awards and certifications",
    "leadership": "leadership, extracurriculars and positions of responsibility",
}

# Topic kinds that belong to each area, used to steer the planner.
AREA_KINDS = {
    "projects": "project",
    "experience": "experience",
    "skills": "fundamentals",
    "education": "education",
    "achievements": "achievement",
    "leadership": "leadership",
}

_COMPILED = {key: re.compile(rf"^\W*({pattern})\W*$", re.I) for key, pattern in AREAS.items()}


def _heading(line: str) -> str | None:
    text = line.strip().strip("•-–:|").strip()
    if not text or len(text) > 48 or len(text.split()) > 6:
        return None
    for key, regex in _COMPILED.items():
        if regex.match(text):
            return key
    return None


def split(resume: str) -> dict[str, str]:
    """Map area -> text under that heading. Text before the first heading is 'header'."""
    found: dict[str, list[str]] = {}
    current = "header"
    for line in resume.splitlines():
        key = _heading(line)
        if key:
            current = key
            found.setdefault(current, [])
            continue
        found.setdefault(current, []).append(line)
    return {key: "\n".join(lines).strip() for key, lines in found.items() if "\n".join(lines).strip()}


def focus(resume: str, areas: list[str]) -> tuple[str, list[str]]:
    """Return (text restricted to the chosen areas, areas actually found).
    Falls back to the whole resume when none of the chosen sections can be located."""
    if not areas:
        return resume, []
    parts = split(resume)
    hits = [area for area in areas if area in parts]
    if not hits:
        return resume, []
    text = "\n\n".join(parts[area] for area in hits)
    return text, hits

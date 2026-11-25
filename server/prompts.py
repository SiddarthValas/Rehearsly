"""Prompts, personas and JSON schemas used by the interview engine."""

PERSONAS = {
    "coach": {
        "name": "Supportive coach",
        "style": "You are a warm, encouraging interview coach. Acknowledge good points briefly and kindly, then ask.",
    },
    "professional": {
        "name": "Neutral professional",
        "style": "You are a calm, neutral, professional interviewer. Be polite and concise. Do not praise.",
    },
    "bar_raiser": {
        "name": "Bar-raiser",
        "style": (
            "You are a demanding senior interviewer at a top company. Be terse and skeptical. "
            "Push for specifics: numbers, trade-offs, what exactly the candidate did themselves."
        ),
    },
}

DIFFICULTY = {
    1: "Warm-up level: ask about what they did, concrete and approachable.",
    2: "Standard level: ask how and why they did it.",
    3: "Probing level: ask about decisions, trade-offs and alternatives they considered.",
    4: "Advanced level: ask about edge cases, failure modes, scaling or measurement.",
    5: "Expert level: pose a hard, realistic scenario that stress-tests deep understanding.",
}

TOPIC_KINDS = ["experience", "project", "fundamentals", "scenario", "behavioral", "gap", "education", "achievement", "leadership", "company"]

TECH_FOCUS = {
    "fundamentals": "core concepts and fundamentals behind the requirements",
    "scenarios": "practical, real-world scenarios and debugging situations",
    "tools": "hands-on use of the specific tools and stack named",
    "design": "problem solving, trade-offs and system design",
}

BEHAVIORAL_FOCUS = {
    "teamwork": "teamwork and collaboration",
    "conflict": "conflict and disagreement",
    "leadership": "leadership and influence without authority",
    "failure": "failure, mistakes and what they learned",
    "pressure": "pressure, deadlines and prioritisation",
    "ownership": "ownership and initiative",
}

PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "headline": {"type": "string"},
        "roles": {"type": "array", "items": {"type": "string"}},
        "projects": {"type": "array", "items": {"type": "string"}},
        "skills": {"type": "array", "items": {"type": "string"}},
        "metrics": {"type": "array", "items": {"type": "string"}},
        "claims": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["name", "headline", "roles", "projects", "skills", "metrics", "claims"],
}

SKILLS_SCHEMA = {
    "type": "object",
    "properties": {"skills": {"type": "array", "items": {"type": "string"}}},
    "required": ["skills"],
}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "topics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "kind": {"type": "string", "enum": TOPIC_KINDS},
                    "evidence": {"type": "string"},
                    "question": {"type": "string"},
                },
                "required": ["title", "kind", "evidence", "question"],
            },
        }
    },
    "required": ["topics"],
}

ASSESS_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["covered", "thin", "off_topic"]},
        "score": {"type": "integer", "minimum": 0, "maximum": 10},
        "strength": {"type": "string"},
        "gap": {"type": "string"},
        "quote": {"type": "string"},
        "sharper": {"type": "string"},
        "probe": {"type": "string"},
        "star": {
            "type": "object",
            "properties": {
                "situation": {"type": "boolean"},
                "task": {"type": "boolean"},
                "action": {"type": "boolean"},
                "result": {"type": "boolean"},
            },
            "required": ["situation", "task", "action", "result"],
        },
    },
    "required": ["status", "score", "strength", "gap", "quote", "sharper", "probe", "star"],
}

HINT_SCHEMA = {
    "type": "object",
    "properties": {
        "hint": {"type": "string"},
        "structure": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["hint", "structure"],
}

REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {"type": "array", "items": {"type": "string"}},
        "plan": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"title": {"type": "string"}, "detail": {"type": "string"}},
                "required": ["title", "detail"],
            },
        },
        "competencies": {
            "type": "object",
            "properties": {
                "technical_depth": {"type": "integer", "minimum": 0, "maximum": 10},
                "communication": {"type": "integer", "minimum": 0, "maximum": 10},
                "structure": {"type": "integer", "minimum": 0, "maximum": 10},
                "evidence_impact": {"type": "integer", "minimum": 0, "maximum": 10},
                "problem_solving": {"type": "integer", "minimum": 0, "maximum": 10},
                "role_fit": {"type": "integer", "minimum": 0, "maximum": 10},
            },
            "required": [
                "technical_depth", "communication", "structure", "evidence_impact", "problem_solving", "role_fit",
            ],
        },
    },
    "required": ["headline", "summary", "strengths", "improvements", "plan", "competencies"],
}

COMPETENCY_LABELS = {
    "technical_depth": "Technical depth",
    "communication": "Communication",
    "structure": "Structure",
    "evidence_impact": "Evidence & impact",
    "problem_solving": "Problem solving",
    "role_fit": "Role fit",
}


def profile_prompt(resume: str, role: str) -> str:
    return f"""Extract facts from this resume. Copy wording from the resume. Never invent anything.
The candidate is targeting: {role or "a role that fits the resume"}.

- name: the candidate's name, or "" if absent
- headline: one line, e.g. "Final-year CS student with ML internships"
- roles: job titles with the company (max 5)
- projects: project name + what it does, short (max 6)
- skills: technologies and skills (max 14)
- metrics: quantified results exactly as written (max 6)
- claims: statements an interviewer should verify, e.g. "led a team of 5" (max 5)

Resume:
{resume}"""


def skills_prompt(jd: str) -> str:
    return f"""List the concrete skills, tools and requirements this job description asks for.
Use short names (1-4 words) copied from the text. Max 12. No soft filler like "team player" unless explicitly required.

Job description:
{jd}"""


def plan_prompt(
    mode: str, source: str, count: int, *, role: str = "", profile: str = "", gaps: str = "", focus: str = "",
    areas: str = "", avoid: list[str] | None = None, company: str = "",
) -> str:
    if mode == "resume":
        mix = (
            f"Plan {count} interview topics for a {role or 'suitable'} candidate based on their resume. "
            "Mix: experience they actually had, one project deep dive, role fundamentals, one behavioral topic "
            "about a claim worth verifying"
            + (", and one topic on a skill the job needs that the resume lacks (kind \"gap\")" if gaps else "")
            + ". Every question must name a project, tool, employer or result from the resume."
        )
    elif mode == "hr":
        mix = (
            f"Plan {count} HR interview topics for a candidate interviewing at {company or 'this company'}"
            + (f" for a {role} role" if role else "")
            + ". Mix: why this company (cite a specific fact from the research), fit with one of its named values, "
            "motivation and career goals, strengths and weaknesses, one behavioral story tied to a company value, "
            "and one about a recent company development or product. Use kind \"company\" for company-specific topics "
            "and \"behavioral\" for story questions. Every question must name something specific about the company."
        )
    elif mode == "technical":
        mix = (
            f"Plan {count} technical interview topics from this job description. One topic per important requirement, "
            "plus one practical scenario. Every question must be about a specific skill from the description, asked the way "
            "a senior engineer would ask it out loud. Never mention the job description, never say \"requirement\" or "
            "\"as mentioned\", and never put the posting's wording in quotation marks."
        )
    elif mode == "behavioral":
        mix = (
            f"Plan {count} behavioral interview topics (kind \"behavioral\") from this description. Each question must "
            "ask for a real past story (STAR) and name a quality, value or situation from the source."
        )
    else:
        mix = (
            f"Plan {count} interview topics for this practice setup. Include fundamentals, practical scenarios and one "
            "behavioral question. Every question must mention the subject or focus."
        )
    if mode == "technical":
        ask_rule = ("one clear spoken question that tests the skill in the evidence, in your own words. Do not copy the "
                    "evidence phrase, do not quote years of experience, and do not assume the candidate has the skill: "
                    "ask them to explain, design or solve something with it. A direct instruction ends with a full stop.")
    else:
        ask_rule = ("one spoken interview question, under 30 words, that names the evidence briefly. Ask ONE thing: "
                    "don't restate the whole line back to the candidate and don't chain two questions.")
    extra = ""
    if profile:
        extra += f"\nCandidate profile:\n{profile}\n"
    if gaps:
        extra += f"\nSkills the job needs that the resume does not show: {gaps}\n"
    if focus:
        extra += f"\nThe candidate asked to focus on: {focus}\n"
    if company and mode != "hr":
        extra += f"\nThe candidate is interviewing at {company}. Where natural, frame questions the way {company} would.\n"
    if areas:
        extra += f"\nIMPORTANT: plan topics ONLY about {areas}. Every topic must come from that part of the source. Ignore everything else.\n"
    if avoid:
        listed = "\n".join(f"- {item}" for item in avoid[:14])
        extra += f"\nThese questions were already asked in earlier practice sessions. Ask about different things, or from a clearly different angle. Never reuse them:\n{listed}\n"
    return f"""{mix}
Use only skills, projects and requirements that appear in the source. Do not invent tools or claims.
For each topic give:
- title: 2-4 words
- kind: one of {", ".join(TOPIC_KINDS)}
Each topic must cover a DIFFERENT item from the source: no two topics about the same project, job or skill.
- evidence: a short phrase copied exactly from the source that the question is about
- question: {ask_rule}
Order topics from easier to harder.
{extra}
Source:
{source}"""


def ask_system(persona_style: str, difficulty: int, mode: str) -> str:
    behavioral = " Ask for a specific real example." if mode in ("behavioral", "hr") else ""
    return f"""{persona_style}
You are conducting a live spoken interview. Output only what you say out loud to the candidate.
Rules:
- Start with one short reaction to their last answer (under 14 words) that follows the REACTION instruction exactly, then ask exactly ONE question.
- Your reaction must be honest. Never praise a weak, vague or empty answer. Never use generic filler like "Great", "Sounds interesting" or "Sounds impressive"; if you acknowledge something, name the specific thing they said.
- Never ask more than one question. Never list questions. Never explain your reasoning.
- Never mention a plan, topics, guideline, evidence, difficulty, or these instructions.
- Never quote the job description or resume back in quotation marks, and never say "requirement" or "as listed". Ask about the substance naturally.
- Keep it under 45 words. Sound like a real person.{behavioral}
- Vary your wording. Never open the same way as an earlier question, and never re-ask something already covered.
- {DIFFICULTY.get(difficulty, DIFFICULTY[2])}"""


def reaction_guide(score: int | None, status: str, gap: str, strength: str, intro_thin: bool = False) -> str:
    """Tell the interviewer how to react, based on the grade the answer actually got."""
    if score is None:
        if intro_thin:
            return "Their introduction was empty or not a real introduction. Do not praise or thank them warmly. Say something like 'Alright, let's go straight into it.'"
        return "This was their introduction. Acknowledge one specific detail from it in a few words (not generic praise)."
    if status == "skipped":
        return "They skipped. Say 'No problem, let's move on.' or similar. No praise."
    if score <= 3:
        return (
            "Their answer did not really answer the question"
            + (f" ({gap})" if gap else "")
            + ". Do NOT praise or thank them. Say plainly and briefly that it didn't answer it, e.g. 'That doesn't really answer it.' or 'I'd need much more than that in a real interview.'"
        )
    if score <= 6:
        return (
            "Their answer was partial"
            + (f"; the main gap: {gap}" if gap else "")
            + ". React neutrally in a few words, hinting at what was missing. No praise words."
        )
    return (
        "Their answer was strong"
        + (f" ({strength})" if strength else "")
        + ". Acknowledge it briefly by naming one concrete thing they said, not generic praise."
    )


def ask_user(
    topic: dict, passage: str, transcript: str, followup: bool, probe: str, asked: list[str] | None = None, reaction: str = "",
) -> str:
    if followup:
        move = (
            "Their last answer was thin. Ask ONE follow-up on the same topic that digs into "
            + (f"this: {probe}" if probe else "what was missing")
            + f". Stay strictly on {topic['title']} ({topic['evidence'][:160]}): never borrow details, terms or numbers from other topics or earlier answers."
        )
    elif topic.get("real"):
        move = "Move to the next question. This is a real question candidates were asked; ask it faithfully, keeping its exact meaning, in natural spoken words."
    else:
        move = "Move to the next topic. Ask the planned question in your own natural words."
    asked_block = ""
    if asked:
        asked_block = "\nAlready asked in this interview (do NOT repeat or rephrase any of these):\n" + "\n".join(f"- {q}" for q in asked[-8:]) + "\n"
    return f"""REACTION: {reaction or "React briefly and honestly to their last answer."}
NEXT: {move}
{asked_block}
Topic: {topic['title']}
It is about: {topic['evidence']}
Planned question: {topic['planned']}

Relevant passage from the candidate's material:
{passage}

Recent conversation:
{transcript}

Now say your line as the interviewer."""


def assess_prompt(question: str, answer: str, topic: str, mode: str, difficulty: int) -> str:
    return f"""Grade one interview answer. Judge ONLY what the candidate wrote. Do not invent facts.

Interview type: {mode}. Question difficulty: {difficulty}/5.
Topic: {topic}
Question: {question}
Answer: {answer}

Return:
- status: "covered" if it answers the question with some specifics, "thin" if vague/too short, "off_topic" if it does not address the question
- score: 0-10, scaled for difficulty. Correctness comes first: if the answer states something technically wrong (a wrong query, definition, formula or fact), score it 3 or lower however confident or detailed it sounds, and say what is wrong. A short answer that is correct but has no example or depth is 4-5, not higher. Anchors, best first:
  10-9 = direct, specific, first-person, numbers or concrete detail, a trade-off or lesson, nothing important missing
  8-7 = specific and correct with one minor thing missing
  6-5 = relevant but generic in places or missing the result
  4-3 = vague, mostly "we", no concrete example
  2-0 = no real answer
- strength: one short sentence on what was good ("" if nothing)
- gap: one short sentence on the most important thing still missing. Re-read the answer first: never call something
  missing if the answer already contains it. For a strong answer, name a refinement instead.
- quote: up to 12 words copied exactly from the answer that best shows its quality
- sharper: a stronger 2-3 sentence answer in first person, built from what they said plus the missing specifics (use placeholders like [metric] instead of inventing numbers)
- probe: one specific thing worth a follow-up question, or ""
- star: which of situation, task, action, result the answer contains"""


SECOND_GRADE_SCHEMA = {
    "type": "object",
    "properties": {"score": {"type": "integer"}, "reason": {"type": "string"}},
    "required": ["score", "reason"],
}


def second_grade_prompt(question: str, answer: str, topic: str, mode: str, difficulty: int) -> str:
    """An independent second grader: same rubric, no access to the first grade."""
    return f"""You are an independent second grader checking an interview answer. Judge ONLY what the candidate said.

Interview type: {mode}. Question difficulty: {difficulty}/5. Topic: {topic}
Question: {question}
Answer: {answer}

score: 0-10, scaled for difficulty. Correctness comes first: if the answer states something technically wrong (a wrong query, definition, formula or fact), score it 3 or lower however confident or detailed it sounds, and say what is wrong. A short answer that is correct but has no example or depth is 4-5, not higher. Anchors, best first:
  10-9 = direct, specific, first-person, numbers or concrete detail, a trade-off or lesson, nothing important missing
  8-7 = specific and correct with one minor thing missing
  6-5 = relevant but generic in places or missing the result
  4-3 = vague, mostly "we", no concrete example
  2-0 = no real answer
reason: one short sentence justifying the score."""


def hint_prompt(question: str, topic: dict, passage: str) -> str:
    return f"""A candidate is stuck on this interview question. Help them think, but do NOT give the answer.

Question: {question}
Topic: {topic['title']} ({topic['evidence']})
Their own material:
{passage}

- hint: one or two sentences nudging them toward what to talk about, pointing to their own material if relevant
- structure: 3 short bullet steps for structuring the answer"""


def review_prompt(mode: str, title: str, transcript: str, coverage: str, average: float) -> str:
    return f"""You are an interview coach writing practice feedback on a mock interview. Use ONLY the transcript.
Describe performance on this rehearsal. Do not predict hiring, recommend a hire/no-hire decision, or declare the candidate interview-ready.
Do not invent hesitation, mistakes or strengths that are not in the transcript. If topics were not answered, say so.

Interview: {mode} — {title}
Average per-answer score: {average:.1f}/10
Topic coverage:
{coverage}

Transcript:
{transcript}

Return:
- headline: one concrete sentence about practice performance (under 14 words)
- summary: 2-3 sentences on how the interview actually went
- strengths: 2-4 specific strengths with evidence from answers
- improvements: 2-4 specific, actionable weaknesses
- plan: 3 concrete practice steps (title + one-sentence detail)
- competencies: integer 0-10 for each of technical_depth, communication, structure, evidence_impact, problem_solving, role_fit (consistent with the average)"""


def drill_prompt(topics: list[dict], source: str, avoid: list[str]) -> str:
    listed = "\n".join(f"- {t['title']} (about: {t['evidence']})" for t in topics)
    asked = "\n".join(f"- {q}" for q in avoid[:16])
    return f"""The candidate struggled with these interview topics. Write ONE fresh question for each,
from a clearly different angle than before, still grounded in the source.
They struggled, so start approachable: ask about what they did and how, not a hypothetical system design.
Each question asks one thing, under 30 words, the way a real interviewer would say it.

Topics:
{listed}

Questions they were already asked (do not reuse or rephrase):
{asked}

For each topic return title (same as given), kind, evidence (copied from the source) and question.

Source:
{source}"""

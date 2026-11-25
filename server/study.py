"""Grading study: does the AI grader agree with people?

A fixed set of 24 interview answers, deliberately spread from excellent to empty, graded by the same two AI
graders the live interview uses. People rate the same answers blind on the same 0-10 rubric in the browser, and
the frontend computes human-vs-AI and human-vs-human agreement (exact, within 1, MAE, Pearson, quadratic kappa).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from server import engine

RUBRIC = [
    ("10-9", "Direct, specific, first-person, numbers or concrete detail, a trade-off or lesson, nothing important missing"),
    ("8-7", "Specific and correct with one minor thing missing"),
    ("6-5", "Relevant but generic in places, or missing the result"),
    ("4-3", "Vague, mostly \"we\", no concrete example"),
    ("2-0", "No real answer"),
    ("≤ 3", "Anything technically wrong, however confident it sounds. Correct but short, with no example: 4-5"),
]

# Mixed order on purpose so raters don't see the same question's strong and weak answers back to back.
ITEMS = [
    {"id": "s01", "mode": "technical", "topic": "Imbalanced data",
     "question": "How would you handle a heavily imbalanced dataset when building a fraud classifier?",
     "answer": "In my last project fraud was 0.4% of transactions. I kept a time-based split so we didn't leak future data, then compared class weights in XGBoost against SMOTE. Class weights won on validation PR-AUC, 0.62 against 0.55. I dropped accuracy as a metric and tuned the threshold for 80% precision, because the ops team could only review about 200 cases a day. The trade-off was missing some low-value fraud, which we accepted."},
    {"id": "s02", "mode": "behavioral", "topic": "Disagreement",
     "question": "Tell me about a time you disagreed with a teammate.",
     "answer": "We had some disagreements in the team but we discussed it and solved it together. Communication is key in any team."},
    {"id": "s03", "mode": "hr", "topic": "Why this company",
     "question": "Why do you want to join our company?",
     "answer": "Your company is a leader in the industry and has a great work culture. I want to grow my career here and learn new things."},
    {"id": "s04", "mode": "technical", "topic": "SQL",
     "question": "How do you find the second highest salary in an employees table?",
     "answer": "SELECT MAX(salary) FROM employees WHERE salary < (SELECT MAX(salary) FROM employees). Or use DENSE_RANK() over salary descending and keep rank 2, which handles ties properly and generalises to the nth highest."},
    {"id": "s05", "mode": "technical", "topic": "Deployment",
     "question": "Tell me about a model you deployed to production.",
     "answer": "I really enjoy working with data and I'm a fast learner. I think deployment is very important in the industry nowadays and every data scientist should know it."},
    {"id": "s06", "mode": "behavioral", "topic": "Biggest achievement",
     "question": "What's your biggest achievement so far?",
     "answer": "Winning HackVeda'26 out of 140 teams. I led the backend of MitraSetu, a RAG assistant that answers questions about government schemes in Hindi and English. I built the retrieval pipeline and a test set of 50 real queries, and on the final night we raised answer accuracy from 58% to 84% by fixing how tables were chunked. The judges called out that accuracy demo specifically."},
    {"id": "s07", "mode": "technical", "topic": "Regularization",
     "question": "Explain the difference between L1 and L2 regularization.",
     "answer": "L1 adds the absolute value of the weights to the loss and L2 adds the squares. L1 can push weights to exactly zero, so it does feature selection, while L2 just shrinks them. I mostly use L2 by default."},
    {"id": "s08", "mode": "hr", "topic": "Weakness",
     "question": "What is your greatest weakness?",
     "answer": "I'm a perfectionist and I work too hard."},
    {"id": "s09", "mode": "technical", "topic": "System design",
     "question": "How would you design a URL shortener?",
     "answer": "I'd use a database to store the URLs and generate a short code for each one. When someone visits the short link, it redirects them. Maybe add caching to make it faster."},
    {"id": "s10", "mode": "behavioral", "topic": "Failure",
     "question": "Tell me about a time you failed.",
     "answer": "I once missed a deadline for a class project because I underestimated how long the data cleaning would take. I told the professor early and submitted two days late. Since then I break tasks into smaller pieces and add buffer time."},
    {"id": "s11", "mode": "technical", "topic": "SQL",
     "question": "How do you find the second highest salary in an employees table?",
     "answer": "You can do SELECT salary FROM employees ORDER BY salary LIMIT 2, and the second row is the answer."},
    {"id": "s12", "mode": "technical", "topic": "Browser request",
     "question": "What happens when you type a URL into a browser and press Enter?",
     "answer": "The browser checks its cache, then resolves the domain through DNS, opens a TCP connection and does a TLS handshake for HTTPS. It sends an HTTP GET, the server returns HTML, and the browser parses it, fetches the CSS, JavaScript and images, builds the DOM and render tree, and paints the page. Keep-alive and CDNs make the later requests faster."},
    {"id": "s13", "mode": "behavioral", "topic": "Disagreement",
     "question": "Tell me about a time you disagreed with a teammate.",
     "answer": "In our capstone, a teammate wanted to train a deep model on about 2,000 rows of logs, and I thought it would overfit. Instead of arguing, I proposed we each build a baseline in one day and compare them on the same validation split. The gradient-boosted baseline beat the neural net by 6 F1 points, so we went with it and he took over feature engineering. I learned that a quick experiment ends a debate faster than opinions do."},
    {"id": "s14", "mode": "technical", "topic": "Overfitting",
     "question": "What is overfitting, and how do you detect it?",
     "answer": "It's when the model memorises the training data. Training accuracy is high but test accuracy is low."},
    {"id": "s15", "mode": "hr", "topic": "Five years",
     "question": "Where do you see yourself in five years?",
     "answer": "I want to be an ML engineer who owns models end to end, from data to monitoring. In five years I'd like to lead a small team working on applied NLP, and I'm working toward that by taking on deployment work now."},
    {"id": "s16", "mode": "behavioral", "topic": "Initiative",
     "question": "Describe a time you took initiative.",
     "answer": "We noticed that our college fest registrations were messy, so we built a Google Form and a sheet to track them. It worked well and everyone liked it."},
    {"id": "s17", "mode": "technical", "topic": "RAG",
     "question": "Explain how a retrieval-augmented generation (RAG) system works.",
     "answer": "You split documents into chunks, embed them and store them in a vector database. At query time you embed the question, retrieve the top-k most similar chunks and put them in the prompt so the LLM answers from them. In my hackathon project we used FAISS with roughly 500-token chunks. The hardest part was tables, which we turned into text rows before embedding."},
    {"id": "s18", "mode": "technical", "topic": "Deployment",
     "question": "Tell me about a model you deployed to production.",
     "answer": "During my internship I deployed a churn model as a FastAPI service on Azure. I containerised it with Docker, validated inputs with Pydantic, and logged predictions so we could check drift weekly using PSI. After two months the PSI on tenure crossed 0.2, so we retrained. Latency stayed under 50 ms at p95."},
    {"id": "s19", "mode": "behavioral", "topic": "Pressure",
     "question": "Tell me about a time you worked under pressure.",
     "answer": "Pressure is something everyone faces. In exams I usually study the night before and I think I do well under pressure. Also during the hackathon we had 24 hours and we were tired but we finished. I like coffee during those times."},
    {"id": "s20", "mode": "hr", "topic": "Weakness",
     "question": "What is your greatest weakness?",
     "answer": "I used to avoid asking for help and would stay stuck for hours. During my Worley internship that cost me a full day on a Power BI refresh bug. Now I give myself a 45-minute limit before asking, and I keep a short log of what I tried so the question is quick to answer."},
    {"id": "s21", "mode": "technical", "topic": "Processes and threads",
     "question": "What's the difference between a process and a thread?",
     "answer": "A process has its own memory space, while threads inside a process share memory. So threads are cheaper to create and switch between, but you need locks to avoid race conditions. Processes are isolated, so one crashing doesn't take the others down."},
    {"id": "s22", "mode": "technical", "topic": "Gradient descent",
     "question": "Explain how gradient descent works.",
     "answer": "I don't know, I haven't studied that yet."},
    {"id": "s23", "mode": "hr", "topic": "Why hire you",
     "question": "Why should we hire you?",
     "answer": "I've already shipped ML work outside the classroom: a churn model at IBM that improved recall by 12%, and a RAG assistant that won a national hackathon. I'm comfortable with both the modelling and the engineering around it, and I learn fast. I'd need some time on your specific domain, but I can contribute to the data pipeline from the first month."},
    {"id": "s24", "mode": "behavioral", "topic": "Feedback",
     "question": "Tell me about a time you received critical feedback.",
     "answer": "My internship manager told me my status updates were too long and buried the important part. I started writing updates with the result in the first line, then blockers, then details. A few weeks later he said the updates were the easiest on the team to read, and I still write them that way."},
]

# Each answer was written to sit in one quality band, so the grader can be checked without any people:
# does it put strong answers above weak ones? (Set by the answer set's author: a sanity check, not a human rating.)
TIERS = {
    "strong": ["s01", "s04", "s06", "s12", "s13", "s17", "s18", "s20", "s23", "s24"],
    "medium": ["s07", "s10", "s15", "s21"],
    "weak": ["s02", "s03", "s08", "s09", "s11", "s14", "s16", "s19"],
    "none": ["s05", "s22"],
}
for _tier, _ids in TIERS.items():
    for _item in ITEMS:
        if _item["id"] in _ids:
            _item["tier"] = _tier

# The same question answered well and badly: the better answer must score higher.
PAIRS = [
    {"better": "s04", "worse": "s11", "what": "SQL: correct query vs a confident wrong one"},
    {"better": "s13", "worse": "s02", "what": "Disagreement: a real story vs a generic line"},
    {"better": "s18", "worse": "s05", "what": "Deployment: concrete details vs off-topic filler"},
    {"better": "s20", "worse": "s08", "what": "Weakness: an honest example vs a cliche"},
]

_BY_ID = {item["id"]: item for item in ITEMS}
_pool = ThreadPoolExecutor(max_workers=4)


def items() -> dict:
    return {"items": ITEMS, "pairs": PAIRS, "rubric": [{"range": r, "meaning": m} for r, m in RUBRIC]}


def _grade_one(item: dict) -> dict:
    session = {"mode": item["mode"], "difficulty": 2, "model": None}
    result = engine._assess(session, item["question"], item["answer"], {"title": item["topic"]})
    check = result.get("check") or {}
    return {
        "id": item["id"],
        # Only a grade where BOTH graders answered counts for the study. If a grader was busy, the live app
        # falls back to one grader or a default, which is fine mid-interview but would contaminate the study.
        # (A skip or a non-answer is scored 0 by rule, with no AI call, so it is complete too.)
        "complete": bool(check) or result["status"] in ("skipped", "off_topic"),
        "score": result["score"],
        "status": result["status"],
        "first": check.get("first"),
        "second": check.get("second"),
        "firstBy": check.get("firstBy", ""),
        "secondBy": check.get("secondBy", ""),
    }


def grade(ids: list[str]) -> dict:
    """Grade up to 2 study answers with the live graders. The browser sends one at a time to stay inside free rate limits."""
    wanted = [_BY_ID[i] for i in dict.fromkeys(ids) if i in _BY_ID][:2]
    if not wanted:
        raise ValueError("No study answers to grade.")
    return {"grades": list(_pool.map(_grade_one, wanted))}

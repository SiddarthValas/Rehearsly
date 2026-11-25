# Independent grading evaluation

Status: protocol only. No independent ratings or new live model results have been collected by these code changes.

Rubric version: `2026-11-25-context-v2`.

## First check with the existing app

1. Open `#/study` and ask three independent people with relevant technical/interview experience to rate all 24 answers.
2. Show each rater only the question, answer, and current rubric. Hide AI grades, developer quality bands, expected pair winners, and other people's ratings. Have raters complete their ratings before looking at result screens. The app supports blind rating, but is not a controlled access system.
3. Use anonymous rater IDs. Export each rater's current RS2 share code after completion and import it into the study. Collect new ratings under the revised rubric; do not reuse RS1 codes or earlier rubric ratings.
4. Run AI grading with the same rubric. Keep incomplete/provider-failure results separate and report how many answers received both grades. Never record an outage as zero or a default candidate score.
5. Report AI-vs-human and human-vs-human mean absolute error, within-one agreement, and quadratic weighted kappa, along with the number of raters and answers compared. Report provider disagreement separately. Agreement with another model is not human validation.

The existing 24 answers were already used to improve the system. Results on them are development-set evidence, not an untouched test of generalization.

## Held-out validation

Before further tuning, freeze a separate set of at least 60 new question-answer pairs with permission to use them. Include factual/keyword questions, explanations, design/scenario questions, and behavioral stories. Cover multiple subjects, answer lengths, and quality levels. Include concise correct answers, confidently incorrect answers, and attempts to manipulate the grader. Do not invent human ratings for synthetic examples.

- Freeze the rubric, prompt version, dataset, and evaluation plan before running the held-out test.
- Have at least three independent raters score every pair without seeing AI grades or author labels.
- Run the same fixed model configuration at least three times on identical inputs to measure repeatability. Keep changed prompts or changed provider configurations in separate runs.
- Record timestamp, rubric version, provider/model identity when available, both raw scores, final score, grading method, disagreements, latency, and failures. Provider-only labels are not exact model provenance; record the actual model from provider responses before claiming model-specific repeatability.
- Report item-level confidence intervals for agreement/error estimates, using bootstrap resampling of question-answer pairs. Report results separately for factual, explanation/design, and behavioral questions, and for short versus long answers.
- Examine a small set of semantically equivalent short/long answers and reordered wording to measure sensitivity to verbosity and paraphrasing.
- Disclose all failures and exclusions. Do not present only pairs on which both providers happened to respond as the overall completion rate.
- Choose error tolerances with the evaluator before viewing results. If the rubric or prompts are changed after seeing results, reserve another new held-out set for the next validation.

Any factual correctness, usefulness, or improvement claim must be bounded by the evaluation actually performed. This study cannot validate a probability of being hired.

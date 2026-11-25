"""Focused-scope regressions; all model calls and session storage are isolated."""
import copy
import unittest
from concurrent.futures import Future
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import engine, llm, main, prompts, store


class ImmediatePool:
    def submit(self, function, *args, **kwargs):
        future = Future()
        try:
            future.set_result(function(*args, **kwargs))
        except Exception as error:
            future.set_exception(error)
        return future


def fake_chat(messages, **kwargs):
    schema = kwargs.get("schema")
    if schema is prompts.ASSESS_SCHEMA:
        return {
            "status": "covered", "score": 8, "strength": "Specific explanation.",
            "gap": "Consider edge cases.", "quote": "", "sharper": "A clearer example.",
            "probe": "", "star": {},
        }
    if schema is prompts.SECOND_GRADE_SCHEMA:
        return {"score": 8, "reason": "Specific explanation."}
    if schema is prompts.REVIEW_SCHEMA:
        return {
            "headline": "Keep building concrete examples", "summary": "You explained your reasoning.",
            "strengths": ["Specific examples"], "improvements": ["Cover edge cases"],
            "plan": [{"title": "Practise edge cases", "detail": "Try a missing-value example."}],
            "competencies": {key: 8 for key in prompts.COMPETENCY_LABELS},
        }
    raise AssertionError("Unexpected model operation")


def fake_question(session, topic, followup, probe, reaction=""):
    yield {"type": "final", "text": topic["planned"]}


class FocusedFlowTests(unittest.TestCase):
    def setUp(self):
        for patcher in (
            patch.object(engine, "_pool", ImmediatePool()),
            patch.object(engine, "_index", return_value=None),
            patch.object(engine, "_next_question", side_effect=fake_question),
            patch.object(llm, "chat", side_effect=fake_chat),
            patch.object(llm, "embed", return_value=None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.repo = store.MemoryRepo()
        import json
        events = list(engine.create({
            "mode": "bank", "company": "Practice Company", "persona": "professional",
            "questions": json.dumps([
                {"question": "How do you find duplicate records in SQL?", "subject": "SQL & databases"},
                {"question": "How do you validate a Python data pipeline?", "subject": "Coding & DSA"},
            ]),
        }, repo=self.repo))
        self.session_id = events[-1]["session"]["id"]

    def answer(self, text):
        return list(engine.reply(self.session_id, text, repo=self.repo))

    def test_interview_followup_and_review_without_predictions(self):
        intro = self.answer("I build data pipelines and use SQL to validate the results.")
        self.assertEqual(intro[-1]["type"], "done")
        thin = self.answer("test")
        self.assertEqual(self.repo.load(self.session_id)["topics"][0]["followups"], 1)
        strong = self.answer("I group the rows by their business keys and compare counts before and after removing duplicate records.")
        finish = self.answer("skip")
        self.assertTrue(finish[-1]["session"]["complete"])
        self.assertFalse(any(event["type"] == "hire" for event in intro + thin + strong + finish))
        result = engine.review(self.session_id, repo=self.repo)
        self.assertEqual(result["score"], 40)
        self.assertEqual(result["readiness"], "Early days")
        self.assertTrue(result["plan"])
        self.assertEqual(len(result["session"]["topics"]), 2)
        self.assertNotIn("hireTrail", result["session"])

    def test_legacy_session_extras_do_not_leak_or_delete_history(self):
        session = self.repo.load(self.session_id)
        for key in ("hireTrail", "committee", "heatmap"):
            session[key] = {"legacy": True}
        before = copy.deepcopy(session)
        with patch.object(engine, "CLIENT_STATE", True):
            view = engine.public(session)
        for key in ("hireTrail", "committee", "heatmap"):
            self.assertNotIn(key, view)
        self.assertEqual(session, before)
        self.assertEqual(view["messages"], before["messages"])
        self.assertEqual(view["source"], before["source"])

    def test_cached_review_uses_practice_band(self):
        session = self.repo.load(self.session_id)
        session["topics"][0].update(status="covered", score=9)
        session["review"] = {"score": 90, "readiness": "Interview-ready", "headline": "Existing feedback"}
        result = engine.review(self.session_id, repo=self.repo)
        self.assertEqual(result["readiness"], "Strong practice performance")
        self.assertEqual(result["score"], 90)

    def test_retired_api_routes_are_unavailable(self):
        client = TestClient(main.app)
        with patch.object(main, "RATE_LIMIT", 0):
            for path in (
                "/api/sessions/example/committee", "/api/sessions/example/heatmap",
            ):
                with self.subTest(path=path):
                    self.assertIn(client.post(path, json={}).status_code, (404, 405))
                    self.assertEqual(client.get(path).status_code, 404)
        routes = {route.path for route in main.app.routes}
        for path in ("/api/sessions", "/api/sessions/{session_id}/answer", "/api/sessions/{session_id}/review", "/api/study/grade", "/api/transcribe", "/api/research/questions"):
            self.assertIn(path, routes)


if __name__ == "__main__":
    unittest.main()


class MirrorModeTests(unittest.TestCase):
    """Mirror mode is back: the hidden persona must stay sealed and the reveal must score the user's calls."""

    def test_sealed_secret_round_trips_and_resists_tampering(self):
        from server import mirror
        token = mirror.seal({"persona": "bluffer", "flaws": ["bluff"]})
        self.assertEqual(mirror.unseal(token)["persona"], "bluffer")
        tampered = token[:-2] + ("AA" if token[-2:] != "AA" else "BB")
        with self.assertRaises(Exception):
            mirror.unseal(tampered)

    def test_mirror_routes_are_registered(self):
        routes = {route.path for route in main.app.routes}
        for path in ("/api/mirror/start", "/api/mirror/self", "/api/mirror/answer", "/api/mirror/reveal"):
            self.assertIn(path, routes)

    def test_long_text_is_trimmed_on_a_word_boundary(self):
        from server import mirror
        text = "Built dashboards in Power BI for a non-profit, freeing up staff time across three teams every week"
        out = mirror._item(text, 40)
        self.assertTrue(out.endswith("..."))
        self.assertTrue(text.startswith(out[:-3]))
        self.assertIn(out[:-3].split()[-1], text.split())

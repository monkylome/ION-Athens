import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from demo_cli import verdicts


class Preflight(unittest.TestCase):
    def setUp(self):
        self.health = {
            "sandbox": {"reachable": True, "llmMessagesLeftToday": 1},
            "graph": {"loaded": True, "nodes": 7101, "edges": 10360},
            "routing": {"enrichment": {"loaded": False}},
        }
        self.loop = {
            "demo": True,
            "lengthM": 200,
            "walkerProgressM": 90,
            "obstacle": {"distanceToDecisionM": 10},
            "crossing": {"id": "x", "open": True},
            "venueMissionId": "v",
            "venueMissionOpen": True,
        }
        self.votes = {k: {"yes": 0, "no": 0} for k in ("x", "v")}
        self.facts = [{"source": "unknown", "value": None}]
        self.rewards = {
            "demo": True,
            "rewards": [
                {
                    "partner": "Θέατρο",
                    "pointsRequired": 60,
                    "standardPointsRequired": 120,
                }
            ],
        }

    def failed(self):
        return {
            label
            for label, ok, _ in verdicts(
                self.health, self.loop, self.votes, self.facts, self.rewards
            )
            if not ok
        }

    def test_fresh_without_optional_survey(self):
        self.assertEqual(self.failed(), set())

    def test_partial_vote_spent_quota_and_stale_fact(self):
        self.health["sandbox"]["llmMessagesLeftToday"] = 0
        self.votes["v"]["yes"] = 1
        self.facts[0].update(source="citizens", value="yes")
        self.assertEqual(self.failed(), {"Sandbox", "Missions", "Olympia"})

    def test_wrong_graph_geometry_and_threshold(self):
        self.health["graph"]["edges"] -= 1
        self.loop["obstacle"]["distanceToDecisionM"] = -1
        self.rewards["rewards"][0]["pointsRequired"] = 120
        self.assertEqual(self.failed(), {"Graph", "Loop", "Rewards"})

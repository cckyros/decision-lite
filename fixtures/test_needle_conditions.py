import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("needle_bridge", root / "python" / "needle_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ConditionPromptTests(unittest.TestCase):
    def test_policy_is_rendered_in_prompt_and_tool_description(self):
        question = {
            "type": "noul",
            "instructions": "Should this be urgent?",
            "criteria": {"true": "priority required", "false": "normal queue"},
            "conditions": {
                "version": 1,
                "facts": {
                    "deadline": {
                        "type": "choice",
                        "instructions": "Classify the deadline.",
                        "criteria": {"within_hour": "within one hour", "later": "later or unspecified"},
                    }
                },
                "rules": [{
                    "id": "near-deadline",
                    "when": [{"fact": "deadline", "op": "eq", "value": "within_hour"}],
                    "then": "true",
                }],
                "default": "false",
            },
        }
        prompt = bridge._condition_prompt(question)
        tool = bridge._tool_schema("urgent", question)
        self.assertIn("first matching rule wins", prompt)
        self.assertIn('deadline eq "within_hour"', prompt)
        self.assertIn('Default outcome: "false"', prompt)
        self.assertIn("Condition policy v1", tool["description"])


if __name__ == "__main__":
    unittest.main()

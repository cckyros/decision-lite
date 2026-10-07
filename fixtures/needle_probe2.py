import json
import needle

state = "The refund was charged twice and the customer is threatening a chargeback."

tool = {
    "name": "set_urgency",
    "description": "Set whether the customer message is urgent and needs a reply within 1 hour.",
    "parameters": {"type": "object", "properties": {"urgent": {"type": "string", "enum": ["true", "false"], "description": "true if urgent"}}, "required": ["urgent"]},
}

tool2 = {
    "name": "assign_team",
    "description": "Assign the customer message to a team. billing handles invoices, refunds and payments; technical handles product bugs and how-to questions.",
    "parameters": {"type": "object", "properties": {"team": {"type": "string", "enum": ["billing", "technical"], "description": "the team"}}, "required": ["team"]},
}

prompts = [
    ("plain_state", state),
    ("wrap_review", f"Review this customer message and set the urgency.\n\n{state}"),
    ("utterance", f"This customer message might need a fast reply: \"{state}\""),
    ("direct", f"Is this urgent? Message: {state}"),
]

for label, prompt in prompts:
    agent = needle.Needle(tools=[tool])
    r = agent.complete(prompt)
    print(f"--- urgent / {label} ---")
    print(json.dumps({k: r.get(k) for k in ("function_calls", "suppressed_calls", "confidence", "reasoning")}, default=str)[:400])

for label, prompt in [
    ("plain_state", state),
    ("wrap", f"Route this customer message to a team.\n\n{state}"),
    ("direct", f"Which team should handle this? Message: {state}"),
]:
    agent = needle.Needle(tools=[tool2])
    r = agent.complete(prompt)
    print(f"--- dept / {label} ---")
    print(json.dumps({k: r.get(k) for k in ("function_calls", "suppressed_calls", "confidence", "reasoning")}, default=str)[:400])

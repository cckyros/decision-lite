import json
import needle

state = "The refund was charged twice and the customer is threatening a chargeback."

variants = {
    "v1_tools_per_q": {
        "urgent": {
            "name": "answer_is_urgent",
            "description": "Decide whether this customer message needs a response within 1 hour.",
            "parameters": {"type": "object", "properties": {"answer": {"type": "string", "enum": ["true", "false"]}}, "required": ["answer"]},
        },
        "dept": {
            "name": "route_department",
            "description": "Route this customer message to a team. billing = invoices, refunds, payments. technical = product bugs and how-to.",
            "parameters": {"type": "object", "properties": {"team": {"type": "string", "enum": ["billing", "technical"]}}, "required": ["team"]},
        },
    },
}

# single tool per agent, imperative user-style utterance
for name, tool in variants["v1_tools_per_q"].items():
    agent = needle.Needle(tools=[tool])
    arg = list(tool["parameters"]["properties"].keys())[0]
    prompt = f'{state}\n\nPlease use the tool to answer.'
    r = agent.complete(prompt)
    print(f"--- {name} ---")
    print(json.dumps({k: r.get(k) for k in ("function_calls", "suppressed_calls", "confidence", "reasoning")}, default=str)[:600])

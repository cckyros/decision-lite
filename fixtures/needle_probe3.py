import json
import needle

state = "The refund was charged twice and the customer is threatening a chargeback."

schemas = [
    # dict schema
    {"is_urgent": {"type": "string", "enum": ["true", "false"]},
     "department": {"type": "string", "enum": ["billing", "technical"]}},
    # typed properties object
    {"type": "object",
     "properties": {
         "is_urgent": {"type": "string", "enum": ["true", "false"],
                       "description": "does this need a reply within 1 hour"},
         "department": {"type": "string", "enum": ["billing", "technical"],
                        "description": "billing=invoices/refunds, technical=bugs"},
         "risk_level": {"type": "string", "enum": ["0", "1", "2"],
                        "description": "anger level: 0=calm 1=frustrated 2=very angry"},
     },
     "required": ["is_urgent", "department", "risk_level"]},
]

for i, schema in enumerate(schemas):
    try:
        r = needle.extract(state, schema)
        print(f"--- extract v{i} ---")
        print(repr(r))
    except Exception as e:
        print(f"--- extract v{i} ERROR: {type(e).__name__}: {e}")

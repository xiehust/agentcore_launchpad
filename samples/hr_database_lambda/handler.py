"""hr-database sample Lambda — exposed as MCP tools through AgentCore Gateway.

The Gateway invokes this function with the tool arguments as the event and the
fully-qualified tool name (``target___tool``) in the Lambda client context.

Seed data is embedded so the sample is self-contained. ``create_payout`` exists
for the Policy phase (Cedar gates it at the gateway); it performs no real
payment.
"""

import time

EMPLOYEES = {
    "EMP-1024": {
        "employee_id": "EMP-1024",
        "name": "Maya Chen",
        "department": "HR Operations",
        "role": "hr-analyst",
        "vacation_days_total": 25,
        "vacation_days_used": 16,
        "vacation_days_pending_approval": 3,
        "location": "Seattle",
    },
    "EMP-2048": {
        "employee_id": "EMP-2048",
        "name": "Diego Ramírez",
        "department": "Finance",
        "role": "platform-admin",
        "vacation_days_total": 25,
        "vacation_days_used": 5,
        "vacation_days_pending_approval": 0,
        "location": "Austin",
    },
    "EMP-4096": {
        "employee_id": "EMP-4096",
        "name": "Wei Zhang",
        "department": "Engineering",
        "role": "engineer",
        "vacation_days_total": 25,
        "vacation_days_used": 12,
        "vacation_days_pending_approval": 2,
        "location": "Shanghai",
    },
}

DEPARTMENTS = [
    {"name": "HR Operations", "head": "EMP-1024", "headcount": 14},
    {"name": "Finance", "head": "EMP-2048", "headcount": 9},
    {"name": "Engineering", "head": "EMP-4096", "headcount": 61},
]

TEAM_CALENDAR = {
    "2026-08-03..2026-08-07": {"conflicts": 1, "notes": "Diego Ramírez OOO 08-05"},
    "2026-08-10..2026-08-14": {"conflicts": 0, "notes": "no conflicts"},
}


def get_employee(args):
    emp = EMPLOYEES.get(str(args.get("employee_id", "")).upper())
    if not emp:
        return {"error": "employee_not_found", "employee_id": args.get("employee_id")}
    remaining = emp["vacation_days_total"] - emp["vacation_days_used"]
    return {**emp, "vacation_days_remaining": remaining}


def list_departments(args):
    return {"departments": DEPARTMENTS}


def check_calendar(args):
    rng = str(args.get("range", ""))
    entry = TEAM_CALENDAR.get(rng, {"conflicts": 0, "notes": "range not indexed — assumed free"})
    return {"range": rng, **entry}


def create_payout(args):
    # Real payment integrations are out of scope (Payments deferred to Phase 02);
    # this simulates the finance write-action that Cedar policy gates in phase 9.
    return {
        "payout_id": f"PAY-{int(time.time())}",
        "employee_id": args.get("employee_id"),
        "amount": args.get("amount"),
        "currency": "USD",
        "status": "created",
    }


TOOLS = {
    "get_employee": get_employee,
    "list_departments": list_departments,
    "check_calendar": check_calendar,
    "create_payout": create_payout,
}


def lambda_handler(event, context):
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    qualified = custom.get("bedrockAgentCoreToolName", "")
    tool_name = qualified.split("___")[-1] if qualified else event.get("__tool__", "")
    fn = TOOLS.get(tool_name)
    if fn is None:
        return {"error": "unknown_tool", "tool": tool_name}
    return fn(event or {})

"""office-facts sample REST API backend (API Gateway → this Lambda).

Demonstrates REST/OpenAPI → MCP conversion through AgentCore Gateway with
api-key outbound auth (the key lives in an AgentCore Identity credential
provider, never in agent code).
"""

import json

FACTS = {
    "address": "Octank Tower, 410 Terry Ave N, Seattle, WA 98109",
    "wifi": "SSID OctankGuest — rotating password posted at reception",
    "holidays": "2026 company holidays: Jan 1, May 25, Jul 3, Sep 7, Nov 26-27, Dec 24-25",
    "gym": "Building gym on floor 3, open 05:00-23:00, badge access",
    "cafeteria": "Cafeteria on floor 2, breakfast 07:30-10:00, lunch 11:30-14:00",
}


def _response(status: int, body) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def lambda_handler(event, context):
    path = event.get("resource", "")
    if path == "/facts":
        return _response(200, {"topics": sorted(FACTS)})
    if path == "/facts/{topic}":
        topic = (event.get("pathParameters") or {}).get("topic", "").lower()
        if topic in FACTS:
            return _response(200, {"topic": topic, "fact": FACTS[topic]})
        return _response(404, {"error": "unknown_topic", "topics": sorted(FACTS)})
    return _response(404, {"error": "not_found"})

#!/usr/bin/env python3
"""E2E: Cedar policy enforcement at the gateway (real ALLOW + DENY).

Uses the platform policy-test endpoint so every evaluation lands in the
decision log the Governance UI renders.

Run:  cd backend && uv run python scripts/e2e_policy.py
"""

import sys

import httpx


def main() -> int:
    client = httpx.Client(base_url="http://localhost:8000", timeout=120)

    cases = [
        ("demo", "hr-database___get_employee", {"employee_id": "EMP-1024"}, "ALLOW"),
        ("demo", "hr-database___create_payout", {"employee_id": "EMP-1024", "amount": 42},
         "DENY"),
        ("river", "hr-database___create_payout", {"employee_id": "EMP-1024", "amount": 42},
         "ALLOW"),
    ]
    failures = 0
    for username, tool, arguments, expected in cases:
        res = client.post(
            "/api/governance/policy-test",
            json={"username": username, "tool": tool, "arguments": arguments},
        )
        res.raise_for_status()
        body = res.json()
        ok = body["outcome"] == expected
        failures += 0 if ok else 1
        print(f"  {'✓' if ok else '✗'} {body['principal']:<22} {tool:<36} "
              f"{body['outcome']:<6} (expected {expected})")
        if body["outcome"] == "DENY":
            print(f"      reason: {body['detail'][:120]}")

    log = client.get("/api/governance/decisions").json()["decisions"]
    print(f"\n  decision log entries: {len(log)} (latest: "
          f"{log[0]['principal']} {log[0]['tool']} {log[0]['outcome']})")

    if failures:
        print(f"E2E POLICY: FAIL ({failures} unexpected outcomes)")
        return 1
    print("E2E POLICY: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

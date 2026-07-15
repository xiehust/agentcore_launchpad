# User Password Login Implementation

## Implementation Order

1. Add typed auth settings and sanitized example configuration.
2. Add the auth router, stateless cookie helpers, and path-protection
   middleware; register both in the FastAPI factory.
3. Add focused backend tests for disabled mode, route boundaries, invalid
   credentials, successful login, logout, cookie tampering/expiry, secure
   cookie configuration, password rotation, docs protection, and `/v1`
   independence.
4. Extend the frontend API client with auth contracts and centralized `401`
   notification for JSON and multipart requests.
5. Add the auth context/gate, login form, pending/error states, and top-bar
   username/logout integration.
6. Add Launchpad-native login styles and responsive rules.
7. Add English and zh-CN locale keys.
8. Document configuration and console-auth architecture.

## Validation

Run focused checks while implementing:

```bash
cd backend && uv run ruff check app/routers/auth.py tests/test_auth.py
cd backend && uv run pytest tests/test_auth.py tests/test_config.py -q
cd frontend && npm run lint && npx tsc --noEmit && npm run build
python3 scripts/i18n_check.py
```

Run the canonical final gate:

```bash
make verify
```

Then start the local stack with explicit auth credentials and verify through a
real browser at desktop and mobile widths:

- initial login gate
- wrong-credential error
- successful login and cookie-backed page access
- logout
- language switching
- no text overflow or overlapping controls

## Risk Points

- Middleware path matching must not capture `/v1` or CORS preflight traffic.
- Both frontend request helpers must emit the session-expired event.
- Test settings caches must be cleared around credential changes.
- `Secure` cookies cannot be used on the default local HTTP stack.
- The existing uncommitted screenshot files are unrelated and must remain
  untouched.

## Review Gates

- Backend tests prove both disabled and enabled behavior.
- The frontend contract matches the backend response shape.
- i18n parity passes.
- Browser requests confirm the HttpOnly cookie, protected API behavior, and
  responsive login layout.
- `make verify` passes before completion is reported.

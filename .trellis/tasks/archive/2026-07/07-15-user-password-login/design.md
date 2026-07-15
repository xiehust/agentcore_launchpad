# User Password Login Design

## Architecture

The feature adds an optional session gate around the existing Launchpad
control-plane API:

```text
Browser
  -> GET /api/auth/status
  -> POST /api/auth/login {username, password}
  <- HttpOnly session cookie
  -> protected /api/* request with cookie
  -> POST /api/auth/logout

Backend
  -> auth middleware checks protected paths
  -> HMAC verification uses local Launchpad settings only
  -> existing routers execute unchanged after authentication
```

No user row, server-side session row, Cognito call, or other AWS dependency is
introduced.

## Configuration

Add three fields to `Settings`, preserving the established
defaults < YAML < environment < init precedence:

- `auth_username: str = "admin"`
- `auth_password: SecretStr | None = None`
- `auth_cookie_secure: bool = False`

The corresponding environment variables are
`LAUNCHPAD_AUTH_USERNAME`, `LAUNCHPAD_AUTH_PASSWORD`, and
`LAUNCHPAD_AUTH_COOKIE_SECURE`. Authentication is enabled only when
`auth_password` is non-empty.

The session lifetime remains a code constant of 12 hours, matching the SkillOpt
reference. It is not a user-facing tuning surface for this simple gate.

## Backend Contract

Add `backend/app/routers/auth.py` with:

- `GET /api/auth/status`
  - Public.
  - Returns `{auth_required, authenticated, username}`.
  - `username` is returned only for an authenticated, enabled session.
- `POST /api/auth/login`
  - Public.
  - Accepts `{username, password}` with bounded strings.
  - When auth is disabled, returns success without setting a cookie.
  - On valid credentials, sets `launchpad_session`.
  - On invalid credentials, returns
    `{code: "auth.invalid_credentials", message, detail: null}` with `401`.
- `POST /api/auth/logout`
  - Clears `launchpad_session`.

The cookie value is `<expiry>.<hmac-sha256>`. The signing key is derived from a
domain-separated hash of the configured username and password. Verification
checks structure, signature with `hmac.compare_digest`, and expiry. Rotating the
credentials changes the signing key, invalidating all prior cookies after the
backend reloads its settings.

Cookie attributes:

- `HttpOnly`
- `SameSite=Lax`
- `Path=/`
- `Max-Age=43200`
- `Secure` from `auth_cookie_secure`

## Route Protection

An HTTP middleware runs only when authentication is enabled.

Protected:

- All `/api/*` paths except the public paths below, including
  `/api/docs` and `/api/openapi.json`.

Public:

- `/api/health`
- `/api/auth/status`
- `/api/auth/login`
- `/v1/*` so the existing API-key contract remains independent
- CORS `OPTIONS` requests

Unauthenticated protected requests return the normal Launchpad envelope:

```json
{
  "code": "auth.required",
  "message": "Authentication required",
  "detail": null
}
```

The auth middleware returns this envelope directly because middleware executes
outside endpoint exception handling.

## Frontend Contract

Add an `AuthGate` around the application:

1. Fetch auth status once on startup.
2. Render a compact loading state while status is unknown.
3. Render the login form only when authentication is required and no session
   is valid.
4. Render the existing application unchanged when authentication is disabled
   or the session is valid.
5. Listen for one application-level unauthorized event. The API client emits
   it for `401` responses outside `/api/auth/*`, covering session expiry across
   JSON and multipart calls.

An auth context exposes the authenticated username and logout command to the
top bar. When auth is enabled, the top bar displays that username and a
Lucide `LogOut` icon button. When auth is disabled, the current demo identity
display remains unchanged.

The login view uses the existing Launchpad brand, tokens, input, button, and
language switcher. It has explicit labels, browser autofill attributes,
keyboard form submission, disabled/pending state, inline error state, and
responsive dimensions. No credentials are stored in local or session storage.

## Compatibility

- Existing local development and all unrelated tests see auth disabled by
  default.
- The Vite dev/preview proxy keeps API and cookie traffic same-origin.
- `/v1` clients continue using `X-Api-Key` without a console cookie.
- Vendored Studio routes are not modified.

## Security Tradeoffs

This is an operator gate, not an identity platform. It deliberately excludes
registration, password recovery, per-user roles, login throttling, and
server-side revocation. SameSite=Lax limits cross-site form requests; production
HTTPS deployments must set `LAUNCHPAD_AUTH_COOKIE_SECURE=true`. Password
rotation plus backend restart is the global session-revocation mechanism.

## Rollback

Unset `LAUNCHPAD_AUTH_PASSWORD` to disable the gate without database or resource
migration. Removing the code later requires no data cleanup.

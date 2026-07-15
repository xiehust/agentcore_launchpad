# Console Authentication

## 1. Scope / Trigger

Use this contract when changing Launchpad console authentication, the `/api`
route boundary, local credential settings, or frontend handling of expired
sessions. This gate is deliberately independent from Cognito demo users and the
public `/v1` API-key surface.

## 2. Signatures

Backend:

```text
GET  /api/auth/status
POST /api/auth/login  {"username": string, "password": string}
POST /api/auth/logout
```

Frontend:

```ts
interface AuthStatus {
  auth_required: boolean;
  authenticated: boolean;
  username: string | null;
}
```

The session cookie is named `launchpad_session` and has a 12-hour lifetime.

## 3. Contracts

Configuration follows the normal settings precedence:

```text
auth_username / LAUNCHPAD_AUTH_USERNAME          default: "admin"
auth_password / LAUNCHPAD_AUTH_PASSWORD          default: unset
auth_cookie_secure / LAUNCHPAD_AUTH_COOKIE_SECURE default: false
```

An unset or empty password disables the gate. When enabled, middleware protects
all `/api/*` paths except:

- `/api/health`
- `/api/auth/status`
- `/api/auth/login`
- CORS `OPTIONS` requests

The middleware never guards `/v1/*`; those routes continue to require
`X-Api-Key`. A successful login sets an HMAC-signed HttpOnly, SameSite=Lax,
Path=/ cookie. Set `auth_cookie_secure=true` when HTTPS is used.

The frontend API boundary dispatches `launchpad-unauthorized` for a `401`
outside `/api/auth/*`. `AuthGate` owns that event and returns the entire console
to the login form. Do not duplicate `401` handling in individual pages.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Password unset | Auth status reports disabled; existing console behavior remains open |
| Missing/invalid login fields | `422 validation.invalid_request` |
| Wrong username or password | `401 auth.invalid_credentials` |
| Missing, malformed, tampered, or expired session | `401 auth.required` |
| Valid session | Protected `/api/*` request proceeds unchanged |
| Missing `/v1` API key while console auth is enabled | Existing `401 auth.missing_api_key` |

Credential comparisons and cookie-signature comparisons must use
`hmac.compare_digest`. The status endpoint must not disclose the configured
username before authentication.

## 5. Good / Base / Bad Cases

- Good: configure a strong password in the process environment and set
  `LAUNCHPAD_AUTH_COOKIE_SECURE=true` behind HTTPS.
- Base: leave the password unset for bootstrap-free local development and
  hermetic tests.
- Bad: protect `/v1` with the console cookie, store login state in localStorage,
  return the username from unauthenticated status, or add per-page `401`
  handlers.

## 6. Tests Required

Backend tests must assert:

- disabled mode remains open and login is a no-op;
- console APIs and API docs are protected when enabled;
- health, auth bootstrap routes, CORS preflight, and `/v1` remain independent;
- wrong credentials set no cookie;
- successful login sets the required cookie attributes;
- logout, tampered/expired cookies, password rotation, and Secure cookies work.

Frontend validation must assert:

- login error and pending states render;
- valid login unlocks the console and shows the operator identity;
- language switching works on the gate;
- logout and a normal API `401` return to login without reload;
- desktop and mobile layouts have no overlap or horizontal overflow.

Run `make verify` after all focused checks.

## 7. Wrong vs Correct

### Wrong

```python
# This couples the console to bootstrapped AWS and changes the /v1 contract.
if path.startswith(("/api", "/v1")):
    validate_cognito_token(request)
```

### Correct

```python
guarded = (path == "/api" or path.startswith("/api/")) and path not in open_paths
if auth_enabled and guarded and not valid_local_session(request):
    return auth_required_envelope()
```

The local operator gate owns only the console `/api` surface. Cognito remains a
Gateway/Cedar demo dependency, and `/v1` remains API-key authenticated.

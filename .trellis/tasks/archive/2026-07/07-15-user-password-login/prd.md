# Add user password login

## Goal

Add a simple username/password gate to the Launchpad console so an
internet-facing deployment does not expose its control-plane APIs without a
login.

## Background

- The requested reference implementation is SkillOpt Studio's optional
  single-operator login. It uses a stateless, expiring HMAC-signed HttpOnly
  cookie and leaves authentication disabled when no password is configured.
- Launchpad currently exposes all console `/api/*` routes without user
  authentication. Its public `/v1` surface has independent `X-Api-Key`
  authentication and must keep that contract.
- Launchpad bootstrap also creates Cognito demo users (`river` and `demo`) for
  Gateway/Cedar demonstrations. Using those users for console login would make
  login depend on bootstrapped AWS resources and live Cognito calls.

## Requirements

- R1. The console must present a username/password login gate when console
  authentication is enabled.
- R2. Successful login must issue an expiring HttpOnly session cookie; invalid,
  expired, or tampered cookies must not authorize requests.
- R3. An authenticated operator must be able to log out, after which protected
  requests return `401`.
- R4. When enabled, all console `/api/*` routes and FastAPI documentation must
  require a valid session except the health and authentication bootstrap
  endpoints.
- R5. `/api/health`, login, and authentication status must remain reachable
  without a session.
- R6. The existing `/v1` API-key surface must remain independent from console
  session authentication.
- R7. Any protected frontend request that receives `401` must return the user to
  the login gate without requiring a page refresh.
- R8. All new user-facing text must be translated in both English and zh-CN.
- R9. Login state must not be persisted in browser-accessible storage.
- R10. The implementation must follow the existing Launchpad configuration
  precedence and remain testable without AWS credentials.
- R11. Console credentials must be one locally configured operator account.
  Authentication must not call Cognito or any other AWS service.
- R12. Console authentication must be disabled when no password is configured;
  enabling it must require an explicit non-empty password. The default username
  is `admin`.
- R13. Deployments terminating HTTPS at the console must be able to mark the
  session cookie `Secure` through configuration without breaking local HTTP
  development.

## Scope

- Backend authentication settings, routes, middleware, and unit tests.
- Frontend typed API methods, application auth gate, login form, and logout
  command.
- Setup/configuration documentation and the sanitized example config.

## Out of Scope

- Registration, password reset, account administration, roles, and permissions.
- Multi-user persistence in SQLite.
- Login throttling and external identity-provider integration.
- Changes to AgentCore Gateway authentication or the `/v1` API-key mechanism.
- Authentication changes inside the vendored Studio application.
- Cognito-backed console login or reuse of the `river`/`demo` Gateway users.

## Acceptance Criteria

- [x] With console authentication disabled, the existing console and backend
  tests continue to work without login.
- [x] With console authentication enabled, unauthenticated `/api/overview` and
  `/api/docs` requests return the standard Launchpad `401` error envelope.
- [x] Health, authentication status, and login remain public; `/v1` requests
  continue to use only their existing API-key authentication.
- [x] Valid credentials set a time-limited HttpOnly, SameSite=Lax cookie and
  unlock the console.
- [x] Wrong credentials do not set a session; tampered and expired cookies are
  rejected.
- [x] Changing the configured password and restarting the backend invalidates
  previously issued sessions.
- [x] Logout clears the cookie and returns the UI to the login form.
- [x] A `401` from any normal frontend API request returns the UI to the login
  form.
- [x] The login form has labeled username/password fields, pending and error
  states, keyboard submission, and responsive layout.
- [x] English and zh-CN locale keys remain in parity.
- [x] `make verify` passes.

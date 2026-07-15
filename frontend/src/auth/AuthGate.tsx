import { KeyRound, LoaderCircle, LogIn } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Btn } from "../components";
import { LangSwitcher } from "../layout/LangSwitcher";
import {
  api,
  ApiError,
  AUTH_UNAUTHORIZED_EVENT,
  type AuthLoginResult,
  type AuthStatus,
} from "../lib/api";
import { AuthContext } from "./auth-context";

const AUTH_DISABLED: AuthStatus = {
  auth_required: false,
  authenticated: true,
  username: null,
};

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    let active = true;
    api
      .authStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setStatus(AUTH_DISABLED);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setStatus({ auth_required: true, authenticated: false, username: null });
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const onLogin = useCallback((result: AuthLoginResult) => {
    setStatus({
      auth_required: result.auth_required,
      authenticated: true,
      username: result.username,
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setStatus({ auth_required: true, authenticated: false, username: null });
    }
  }, []);

  const context = useMemo(
    () => ({
      authRequired: status?.auth_required ?? false,
      username: status?.username ?? null,
      logout,
    }),
    [logout, status?.auth_required, status?.username],
  );

  if (status === null) return <AuthLoading />;
  if (status.auth_required && !status.authenticated) {
    return <LoginPage onLogin={onLogin} />;
  }
  return <AuthContext.Provider value={context}>{children}</AuthContext.Provider>;
}

function AuthLoading() {
  const { t } = useTranslation();
  return (
    <div className="auth-loading" role="status">
      <LoaderCircle size={22} strokeWidth={1.8} aria-hidden="true" />
      <span className="sr-only">{t("auth.checking")}</span>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (result: AuthLoginResult) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError(t("auth.missingCredentials"));
      return;
    }

    setError("");
    setSubmitting(true);
    try {
      const result = await api.login(username.trim(), password);
      onLogin(result);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "auth.invalid_credentials"
          ? t("auth.invalidCredentials")
          : t("auth.loginFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <header className="auth-topbar">
        <div className="brand">
          <span className="glyph" aria-hidden="true" />
          AGENTCORE<em>//</em>LAUNCHPAD
        </div>
        <LangSwitcher />
      </header>
      <main className="auth-main">
        <form className="auth-panel" onSubmit={submit} noValidate>
          <div className="auth-icon" aria-hidden="true">
            <KeyRound size={24} strokeWidth={1.7} />
          </div>
          <div className="kicker">{t("auth.kicker")}</div>
          <h1>{t("auth.title")}</h1>
          <p className="auth-subtitle">{t("auth.subtitle")}</p>

          <div className="auth-fields">
            <div className="auth-field">
              <label htmlFor="auth-username">{t("auth.username")}</label>
              <input
                id="auth-username"
                className="input"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={submitting}
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password">{t("auth.password")}</label>
              <input
                id="auth-password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          <div className="auth-error" role="alert" aria-live="polite">
            {error}
          </div>
          <Btn className="auth-submit" type="submit" primary disabled={submitting}>
            {submitting ? (
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
            ) : (
              <LogIn size={16} aria-hidden="true" />
            )}
            {submitting ? t("auth.signingIn") : t("auth.signIn")}
          </Btn>
        </form>
      </main>
    </div>
  );
}

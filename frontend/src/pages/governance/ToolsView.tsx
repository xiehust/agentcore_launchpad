import { Monitor, Play, RefreshCw, Square, TriangleAlert } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, DataTable, Panel, useToast } from "../../components";
import {
  api,
  type BrowserDemoOptions,
  type BrowserDemoResult,
  type GovernanceToolCatalog,
  type GovernanceToolInfo,
} from "../../lib/api";
import { governanceError } from "./types";

const CODE_DEMO = "import math\nprint('sqrt(1764) =', math.isqrt(1764))";
const BROWSER_DEMO_URL = "https://example.com";
const BrowserLiveView = lazy(() =>
  import("bedrock-agentcore/browser/live-view").then((module) => ({
    default: module.BrowserLiveView,
  })),
);

interface DemoSwitchProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}

function DemoSwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: DemoSwitchProps) {
  return (
    <label className={`gov-demo-switch${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="gov-demo-switch-track" aria-hidden="true">
        <span />
      </span>
      <span>{label}</span>
    </label>
  );
}

export function ToolsView() {
  const { t } = useTranslation();
  const toast = useToast();
  const [catalog, setCatalog] = useState<GovernanceToolCatalog | null>(null);
  const [selected, setSelected] = useState<GovernanceToolInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState(CODE_DEMO);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciOut, setCiOut] = useState("");
  const [browserUrl, setBrowserUrl] = useState(BROWSER_DEMO_URL);
  const [browserOptions, setBrowserOptions] = useState<BrowserDemoOptions | null>(
    null,
  );
  const [browserOptionsError, setBrowserOptionsError] = useState<string | null>(
    null,
  );
  const [webBotAuth, setWebBotAuth] = useState(false);
  const [browserIdentifier, setBrowserIdentifier] = useState("");
  const [profileIdentifier, setProfileIdentifier] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserOut, setBrowserOut] = useState("");
  const [browserSession, setBrowserSession] = useState<BrowserDemoResult | null>(
    null,
  );
  const browserSessionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    setBrowserOptionsError(null);
    const [catalogResult, browserOptionsResult] = await Promise.allSettled([
      api.governanceToolCatalog(),
      api.browserDemoOptions(),
    ]);
    if (catalogResult.status === "fulfilled") {
      const nextCatalog = catalogResult.value;
      setCatalog(nextCatalog);
      setSelected((current) => {
        if (!current) return nextCatalog.tools[0] ?? null;
        return (
          nextCatalog.tools.find((tool) => tool.name === current.name) ??
          nextCatalog.tools[0] ??
          null
        );
      });
    } else {
      setError(governanceError(catalogResult.reason));
    }
    if (browserOptionsResult.status === "fulfilled") {
      const nextOptions = browserOptionsResult.value;
      const readySignedBrowsers = nextOptions.browsers.filter(
        (browser) => browser.status === "READY" && browser.web_bot_auth,
      );
      setBrowserOptions(nextOptions);
      setBrowserIdentifier((current) =>
        readySignedBrowsers.some((browser) => browser.identifier === current)
          ? current
          : (readySignedBrowsers[0]?.identifier ?? ""),
      );
      setProfileIdentifier((current) =>
        nextOptions.profiles.some(
          (profile) =>
            profile.identifier === current && profile.status === "READY",
        )
          ? current
          : "",
      );
    } else {
      setBrowserOptionsError(governanceError(browserOptionsResult.reason));
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const expectedTitle = "AgentCore Launchpad";
    const titleNode = document.querySelector("title");
    if (!titleNode) return;
    const restoreTitle = () => {
      if (document.title !== expectedTitle) document.title = expectedTitle;
    };
    restoreTitle();
    const observer = new MutationObserver(restoreTitle);
    observer.observe(titleNode, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      restoreTitle();
    };
  }, []);

  useEffect(
    () => () => {
      const sessionId = browserSessionRef.current;
      if (sessionId) void api.stopBrowserDemo(sessionId);
    },
    [],
  );

  const runCodeDemo = async () => {
    setCiBusy(true);
    setCiOut("");
    try {
      const result = await api.runCodeInterpreterDemo(code);
      setCiOut(
        `${result.stdout}\n- session ${result.session_id} - ${result.latency_ms}ms`,
      );
    } catch (demoError) {
      setCiOut(governanceError(demoError));
    } finally {
      setCiBusy(false);
    }
  };

  const runBrowserDemo = async () => {
    setBrowserBusy(true);
    setBrowserOut("");
    try {
      const previousSessionId = browserSessionRef.current;
      browserSessionRef.current = null;
      setBrowserSession(null);
      if (previousSessionId) await api.stopBrowserDemo(previousSessionId);
      const result = await api.runBrowserDemo({
        url: browserUrl.trim(),
        web_bot_auth: webBotAuth,
        browser_identifier: webBotAuth ? browserIdentifier : null,
        profile_identifier: profileIdentifier || null,
        save_profile: Boolean(profileIdentifier) && saveProfile,
      });
      browserSessionRef.current = result.session_id;
      setBrowserSession(result);
      setBrowserOut(
        [
          `title: "${result.title}"`,
          `browser: ${result.browser_identifier}`,
          result.profile_identifier
            ? `profile: ${result.profile_identifier}`
            : null,
          `- session ${result.session_id} - ${result.latency_ms}ms`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (demoError) {
      setBrowserOut(governanceError(demoError));
    } finally {
      setBrowserBusy(false);
    }
  };

  const stopBrowserDemo = async () => {
    const sessionId = browserSessionRef.current;
    if (!sessionId) return;
    setBrowserBusy(true);
    try {
      const result = await api.stopBrowserDemo(sessionId);
      browserSessionRef.current = null;
      setBrowserSession(null);
      setBrowserOut(
        result.profile_saved
          ? t("governance.demos.stoppedProfileSaved")
          : t("governance.demos.stopped"),
      );
      if (result.profile_saved === false) {
        toast(t("governance.demos.profileSaveFailed"), "crit");
      }
    } catch (stopError) {
      toast(governanceError(stopError), "crit");
    } finally {
      setBrowserBusy(false);
    }
  };

  const webBotAuthBrowsers =
    browserOptions?.browsers.filter(
      (browser) => browser.status === "READY" && browser.web_bot_auth,
    ) ?? [];
  const readyProfiles =
    browserOptions?.profiles.filter((profile) => profile.status === "READY") ?? [];
  const browserConfigLocked = browserBusy || browserSession !== null;
  const browserStartDisabled =
    browserBusy ||
    !browserUrl.trim() ||
    (webBotAuth && !browserIdentifier);

  return (
    <>
      <div className="gov-toolbar">
        <div className="gov-toolbar-title">
          <strong>{t("governance.tools.title")}</strong>
          <span>
            {catalog?.gateway_url
              ? "launchpad-gw / MCP"
              : t("governance.tools.offline")}
          </span>
        </div>
        <Btn disabled={refreshing} onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("governance.actions.refresh")}
        </Btn>
      </div>

      {error ? (
        <div className="gov-alert gov-alert-error">
          <TriangleAlert size={15} aria-hidden="true" />
          {error}
        </div>
      ) : null}

      <div className="reg-grid gov-section-gap">
        <Panel brk title={t("governance.tools.title")} pad={false}>
          <DataTable
            columns={[
              { key: "name", label: t("governance.tools.name") },
              { key: "source", label: t("governance.tools.source") },
              { key: "auth", label: t("governance.tools.auth") },
            ]}
            isEmpty={!refreshing && (catalog?.tools.length ?? 0) === 0}
            empty={t("governance.tools.empty")}
          >
            {refreshing && !catalog ? (
              <tr>
                <td colSpan={3} className="loading-line">
                  {t("common.loading")}
                </td>
              </tr>
            ) : null}
            {catalog?.tools.map((tool) => (
              <tr
                key={tool.name}
                className={`rowlink${selected?.name === tool.name ? " sel" : ""}`}
                tabIndex={0}
                onClick={() => setSelected(tool)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") setSelected(tool);
                }}
              >
                <td className="pri mono">{tool.name}</td>
                <td>
                  <Chip tone={tool.source === "gateway" ? "aqua" : "muted"}>
                    {tool.source === "gateway" ? "GATEWAY" : "BUILTIN"}
                    {tool.target ? ` / ${tool.target.toUpperCase()}` : ""}
                  </Chip>
                </td>
                <td className="mono dim">{tool.auth}</td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel
          className="drawer"
          title={selected?.name ?? "-"}
          end={
            selected ? (
              <Chip tone="good">{t("governance.tools.ready")}</Chip>
            ) : null
          }
          pad={false}
        >
          {selected ? (
            <>
              <div className="sect">
                <div className="kv">
                  <span className="k">{t("governance.tools.source")}</span>
                  <span className="v">{selected.source}</span>
                </div>
                <div className="kv">
                  <span className="k">{t("governance.tools.auth")}</span>
                  <span className="v">{selected.auth}</span>
                </div>
              </div>
              <div className="sect">
                <h4>{t("governance.tools.description")}</h4>
                <p className="gov-copy">{selected.description}</p>
              </div>
              <div className="sect">
                <h4>{t("governance.tools.schema")}</h4>
                <pre className="code gov-code-wrap">
                  {JSON.stringify(selected.inputSchema, null, 2)}
                </pre>
              </div>
            </>
          ) : null}
        </Panel>
      </div>

      <div className="gov-demo-grid">
        <Panel
          title={t("governance.demos.ciTitle")}
          sub="aws.codeinterpreter.v1"
          end={
            <Btn
              primary
              disabled={ciBusy || !code.trim()}
              onClick={() => void runCodeDemo()}
            >
              <Play size={14} aria-hidden="true" />
              {t("governance.demos.run")}
            </Btn>
          }
        >
          <div className="field gov-demo-field">
            <label htmlFor="governance-code-demo">
              {t("governance.demos.pythonCode")}
            </label>
            <textarea
              id="governance-code-demo"
              className="input mono gov-demo-editor"
              data-testid="ci-code"
              value={code}
              maxLength={4000}
              disabled={ciBusy}
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {ciOut ? (
            <pre className="code gov-demo-output" data-testid="ci-out">
              <span className="k1">{ciOut}</span>
            </pre>
          ) : null}
        </Panel>
        <Panel
          className="gov-browser-demo"
          title={t("governance.demos.brTitle")}
          sub="aws.browser.v1 / DCV"
          end={
            <div className="gov-live-actions">
              <Chip tone={browserSession ? "good" : "muted"}>
                {browserSession
                  ? t("governance.demos.live")
                  : t("governance.demos.idle")}
              </Chip>
              {browserSession ? (
                <Btn
                  disabled={browserBusy}
                  onClick={() => void stopBrowserDemo()}
                >
                  <Square size={13} aria-hidden="true" />
                  {t("governance.demos.stop")}
                </Btn>
              ) : (
                <Btn
                  primary
                  disabled={browserStartDisabled}
                  onClick={() => void runBrowserDemo()}
                >
                  <Play size={14} aria-hidden="true" />
                  {t("governance.demos.start")}
                </Btn>
              )}
            </div>
          }
        >
          <div className="gov-demo-config">
            <div className="field gov-demo-field">
              <label htmlFor="governance-browser-url">
                {t("governance.demos.browserCommand")}
              </label>
              <div className="gov-browser-command">
                <span>GET</span>
                <input
                  id="governance-browser-url"
                  className="input mono"
                  data-testid="browser-url"
                  type="url"
                  value={browserUrl}
                  maxLength={2000}
                  disabled={browserConfigLocked}
                  spellCheck={false}
                  onChange={(event) => setBrowserUrl(event.target.value)}
                />
              </div>
            </div>

            <div className="gov-demo-options">
              <div className="field gov-demo-field">
                <label>{t("governance.demos.requestSigning")}</label>
                <DemoSwitch
                  checked={webBotAuth}
                  disabled={browserConfigLocked}
                  label={t("governance.demos.webBotAuth")}
                  onChange={setWebBotAuth}
                />
              </div>

              {webBotAuth ? (
                <div className="field gov-demo-field">
                  <label htmlFor="governance-browser-resource">
                    {t("governance.demos.browserResource")}
                  </label>
                  <select
                    id="governance-browser-resource"
                    className="input mono"
                    data-testid="browser-resource"
                    value={browserIdentifier}
                    disabled={browserConfigLocked || webBotAuthBrowsers.length === 0}
                    onChange={(event) => setBrowserIdentifier(event.target.value)}
                  >
                    {webBotAuthBrowsers.length === 0 ? (
                      <option value="">
                        {t("governance.demos.noWebBotAuthBrowser")}
                      </option>
                    ) : null}
                    {webBotAuthBrowsers.map((browser) => (
                      <option key={browser.identifier} value={browser.identifier}>
                        {browser.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              <div className="field gov-demo-field">
                <label htmlFor="governance-browser-profile">
                  {t("governance.demos.browserProfile")}
                </label>
                <select
                  id="governance-browser-profile"
                  className="input mono"
                  data-testid="browser-profile"
                  value={profileIdentifier}
                  disabled={browserConfigLocked}
                  onChange={(event) => {
                    setProfileIdentifier(event.target.value);
                    if (!event.target.value) setSaveProfile(false);
                  }}
                >
                  <option value="">{t("governance.demos.noProfile")}</option>
                  {readyProfiles.map((profile) => (
                    <option key={profile.identifier} value={profile.identifier}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field gov-demo-field">
                <label>{t("governance.demos.profilePersistence")}</label>
                <DemoSwitch
                  checked={saveProfile}
                  disabled={browserConfigLocked || !profileIdentifier}
                  label={t("governance.demos.saveProfile")}
                  onChange={setSaveProfile}
                />
              </div>
            </div>
            {browserOptionsError ? (
              <div className="gov-demo-config-error">{browserOptionsError}</div>
            ) : null}
          </div>
          <div className="gov-browser-readout" data-testid="br-out">
            <span>GET {browserUrl}</span>
            {browserOut ? <span className="k1">{browserOut}</span> : null}
          </div>
          <div className="gov-browser-live" data-testid="browser-live-view">
            {browserSession ? (
              <>
                <div className="gov-browser-placeholder">
                  {t("governance.demos.connecting")}
                </div>
                <div className="gov-browser-stream">
                  <Suspense
                    fallback={
                      <div className="gov-browser-placeholder">
                        {t("governance.demos.connecting")}
                      </div>
                    }
                  >
                    <BrowserLiveView
                      signedUrl={browserSession.live_view_url}
                      remoteWidth={browserSession.viewport.width}
                      remoteHeight={browserSession.viewport.height}
                    />
                  </Suspense>
                </div>
              </>
            ) : (
              <div className="gov-browser-empty">
                <Monitor size={24} aria-hidden="true" />
                <span>{t("governance.demos.noSession")}</span>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

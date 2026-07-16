import { Play, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, DataTable, Panel, useToast } from "../../components";
import {
  api,
  type DemoPolicyDecision,
  type GovernanceToolCatalog,
  type GovernanceToolInfo,
  type LegacyGovernancePolicyInfo,
} from "../../lib/api";
import { governanceError, statusTone } from "./types";

const CODE_DEMO = "import math\nprint('sqrt(1764) =', math.isqrt(1764))";
const BROWSER_DEMO_URL = "https://example.com";

export function ToolsView() {
  const { t } = useTranslation();
  const toast = useToast();
  const [catalog, setCatalog] = useState<GovernanceToolCatalog | null>(null);
  const [selected, setSelected] = useState<GovernanceToolInfo | null>(null);
  const [policies, setPolicies] = useState<LegacyGovernancePolicyInfo | null>(null);
  const [decisions, setDecisions] = useState<DemoPolicyDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciOut, setCiOut] = useState("");
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserOut, setBrowserOut] = useState("");

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const [catalogResult, policyResult, decisionResult] = await Promise.allSettled([
      api.governanceToolCatalog(),
      api.legacyGovernancePolicies(),
      api.demoGovernanceDecisions(),
    ]);
    if (catalogResult.status === "fulfilled") {
      setCatalog(catalogResult.value);
      setSelected((current) => {
        if (!current) return catalogResult.value.tools[0] ?? null;
        return (
          catalogResult.value.tools.find((tool) => tool.name === current.name) ??
          catalogResult.value.tools[0] ??
          null
        );
      });
    } else {
      setError(governanceError(catalogResult.reason));
    }
    if (policyResult.status === "fulfilled") setPolicies(policyResult.value);
    if (decisionResult.status === "fulfilled") {
      setDecisions(
        decisionResult.value.decisions.map((decision) => ({
          ...decision,
          source: "demo",
        })),
      );
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runPolicyTest = async (username: "river" | "demo") => {
    setTestBusy(true);
    try {
      await api.runGovernancePolicyTest(username);
      const result = await api.demoGovernanceDecisions();
      setDecisions(
        result.decisions.map((decision) => ({ ...decision, source: "demo" })),
      );
    } catch (testError) {
      toast(governanceError(testError), "crit");
    } finally {
      setTestBusy(false);
    }
  };

  const runCodeDemo = async () => {
    setCiBusy(true);
    setCiOut("");
    try {
      const result = await api.runCodeInterpreterDemo(CODE_DEMO);
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
      const result = await api.runBrowserDemo(BROWSER_DEMO_URL);
      setBrowserOut(
        `title: "${result.title}"\n- session ${result.session_id} - ${result.latency_ms}ms`,
      );
    } catch (demoError) {
      setBrowserOut(governanceError(demoError));
    } finally {
      setBrowserBusy(false);
    }
  };

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

      <div className="gov-grid">
        <Panel
          title={t("governance.demos.ciTitle")}
          sub="aws.codeinterpreter.v1"
          end={
            <Btn primary disabled={ciBusy} onClick={() => void runCodeDemo()}>
              <Play size={14} aria-hidden="true" />
              {t("governance.demos.run")}
            </Btn>
          }
        >
          <div className="code" data-testid="ci-out">
            <span className="k2">import</span> math{"\n"}
            <span className="k2">print</span>(&#39;sqrt(1764) =&#39;,
            math.isqrt(1764))
            {ciOut ? (
              <>
                {"\n\n"}
                <span className="k1">{ciOut}</span>
              </>
            ) : null}
          </div>
        </Panel>
        <Panel
          title={t("governance.demos.brTitle")}
          sub="aws.browser.v1"
          end={
            <Btn
              primary
              disabled={browserBusy}
              onClick={() => void runBrowserDemo()}
            >
              <Play size={14} aria-hidden="true" />
              {t("governance.demos.run")}
            </Btn>
          }
        >
          <div className="code" data-testid="br-out">
            GET https://example.com -&gt; title?
            {browserOut ? (
              <>
                {"\n\n"}
                <span className="k1">{browserOut}</span>
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="gov-grid">
        <Panel
          title={`CEDAR - ${policies?.engine.name ?? "launchpad_pe"}`}
          sub={t("governance.policy.sub")}
          end={
            policies?.engine.attached ? (
              <Chip tone={statusTone(policies.engine.attached_mode)}>
                {policies.engine.attached_mode ?? "-"}
              </Chip>
            ) : (
              <Chip tone="muted">-</Chip>
            )
          }
        >
          <pre className="code gov-policy-preview">
            {policies?.policies
              .map(
                (policy) =>
                  `// ${policy.name} / ${policy.status}\n${policy.statement}`,
              )
              .join("\n\n") ?? t("governance.policy.loading")}
          </pre>
          <div className="gov-actions">
            <Btn disabled={testBusy} onClick={() => void runPolicyTest("demo")}>
              <Play size={14} aria-hidden="true" />
              {t("governance.policy.testAnalyst")}
            </Btn>
            <Btn disabled={testBusy} onClick={() => void runPolicyTest("river")}>
              <Play size={14} aria-hidden="true" />
              {t("governance.policy.testAdmin")}
            </Btn>
          </div>
        </Panel>

        <Panel
          className="dlog"
          title={t("governance.decisions.demoTitle")}
          sub={t("governance.decisions.demoSource")}
          pad={false}
        >
          {decisions.length === 0 ? (
            <div className="empty">{t("governance.decisions.empty")}</div>
          ) : null}
          {decisions.slice(0, 8).map((decision, index) => (
            <div className="row" key={`${decision.at ?? "none"}-${index}`}>
              <span className="t">{decision.at?.slice(11, 19) ?? "-"}</span>
              <span className="who">{decision.principal}</span>
              <span className="res">{decision.tool}</span>
              <Chip tone={statusTone(decision.outcome)}>{decision.outcome}</Chip>
              <Chip tone="muted">DEMO</Chip>
            </div>
          ))}
        </Panel>
      </div>
    </>
  );
}

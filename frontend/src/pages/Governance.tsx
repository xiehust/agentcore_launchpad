import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, DataTable, Panel, ViewHead } from "../components";

interface ToolInfo {
  name: string;
  source: "gateway" | "builtin";
  target?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  auth: string;
}

async function fetchTools(): Promise<{ tools: ToolInfo[]; gateway_url: string | null }> {
  const res = await fetch("/api/tools");
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

interface PolicyInfo {
  engine: { id: string; name: string; status: string; attached_mode: string | null; attached: boolean };
  policies: { id: string; name: string; status: string; statement: string }[];
}

interface Decision {
  at: string | null;
  principal: string;
  tool: string;
  outcome: "ALLOW" | "DENY";
  reason: string;
}

export function Governance() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<ToolInfo | null>(null);
  const [ciOut, setCiOut] = useState<string>("");
  const [ciBusy, setCiBusy] = useState(false);
  const [brOut, setBrOut] = useState<string>("");
  const [brBusy, setBrBusy] = useState(false);
  const [policyInfo, setPolicyInfo] = useState<PolicyInfo | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [testBusy, setTestBusy] = useState(false);
  const [genOut, setGenOut] = useState<string>("");

  const loadDecisions = () => {
    fetch("/api/governance/decisions")
      .then((res) => (res.ok ? res.json() : { decisions: [] }))
      .then((d: { decisions: Decision[] }) => setDecisions(d.decisions))
      .catch(() => {});
  };

  useEffect(() => {
    fetchTools()
      .then((d) => {
        setTools(d.tools);
        setGatewayUrl(d.gateway_url);
        setSelected(d.tools[0] ?? null);
      })
      .catch(() => {
        /* backend offline — catalog stays empty */
      });
    fetch("/api/governance/policies")
      .then((res) => (res.ok ? res.json() : null))
      .then((d: PolicyInfo | null) => d && setPolicyInfo(d))
      .catch(() => {});
    loadDecisions();
  }, []);

  const runPolicyTest = async (username: "river" | "demo") => {
    setTestBusy(true);
    try {
      await fetch("/api/governance/policy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          tool: "hr-database___create_payout",
          arguments: { employee_id: "EMP-1024", amount: 42 },
        }),
      });
      loadDecisions();
    } finally {
      setTestBusy(false);
    }
  };

  const runGeneration = async () => {
    setGenOut("…");
    const res = await fetch("/api/governance/policy-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Allow only users in the platform-admin group to call the check_calendar tool on weekdays.",
        name: `launchpad_gen_${Date.now() % 100000}`,
      }),
    });
    const body = (await res.json()) as {
      available: boolean;
      generation_id?: string;
      status?: string;
      error?: string;
    };
    if (!body.available) {
      setGenOut(`${t("governance.policyGen.unavailable")}: ${body.error ?? ""}`);
      return;
    }
    setGenOut(`generation ${body.generation_id} · ${body.status}`);
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const poll = await fetch(`/api/governance/policy-generation/${body.generation_id}`);
      if (!poll.ok) continue;
      const detail = (await poll.json()) as { status: string; assets: { statement: string }[] };
      setGenOut(`generation ${body.generation_id} · ${detail.status}`);
      if (detail.status === "GENERATED") {
        setGenOut(
          `✓ GENERATED\n${detail.assets.map((a) => a.statement).join("\n---\n").slice(0, 900)}`,
        );
        return;
      }
      if (detail.status.includes("FAILED")) return;
    }
  };

  const runCodeDemo = async () => {
    setCiBusy(true);
    setCiOut("");
    try {
      const res = await fetch("/api/demos/code-interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "import math\nprint('sqrt(1764) =', math.isqrt(1764))" }),
      });
      const body = await res.json();
      setCiOut(
        res.ok
          ? `${body.stdout}\n· session ${body.session_id} · ${body.latency_ms}ms`
          : JSON.stringify(body),
      );
    } catch (err) {
      setCiOut(String(err));
    } finally {
      setCiBusy(false);
    }
  };

  const runBrowserDemo = async () => {
    setBrBusy(true);
    setBrOut("");
    try {
      const res = await fetch("/api/demos/browser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const body = await res.json();
      setBrOut(
        res.ok
          ? `title: "${body.title}"\n· session ${body.session_id} · ${body.latency_ms}ms`
          : JSON.stringify(body),
      );
    } catch (err) {
      setBrOut(String(err));
    } finally {
      setBrBusy(false);
    }
  };

  return (
    <section>
      <ViewHead
        kicker={t("governance.kicker")}
        title={t("governance.title")}
        meta={t("governance.meta")}
      />

      <div className="reg-grid" style={{ marginBottom: 14 }}>
        <Panel
          brk
          title={t("governance.tools.title")}
          sub={gatewayUrl ? `launchpad-gw · MCP` : t("governance.tools.offline")}
          pad={false}
          style={{ "--i": 0 } as CSSProperties}
        >
          <DataTable
            columns={[
              { key: "name", label: t("governance.tools.name") },
              { key: "source", label: t("governance.tools.source") },
              { key: "auth", label: t("governance.tools.auth") },
            ]}
            isEmpty={tools.length === 0}
            empty={t("governance.tools.empty")}
          >
            {tools.map((tool) => (
              <tr
                key={tool.name}
                onClick={() => setSelected(tool)}
                style={{
                  cursor: "pointer",
                  background:
                    selected?.name === tool.name ? "rgba(255,176,0,.045)" : undefined,
                }}
              >
                <td className="pri mono">{tool.name}</td>
                <td>
                  {tool.source === "gateway" ? (
                    <Chip tone="aqua" icon="⇄">
                      GATEWAY{tool.target ? ` · ${tool.target.toUpperCase()}` : ""}
                    </Chip>
                  ) : (
                    <Chip tone="muted" icon="◆">
                      BUILTIN
                    </Chip>
                  )}
                </td>
                <td className="mono dim">{tool.auth}</td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel
          className="drawer"
          title={selected?.name ?? "—"}
          end={
            selected && (
              <Chip tone="good" icon="●">
                {t("governance.tools.ready")}
              </Chip>
            )
          }
          pad={false}
          style={{ "--i": 1 } as CSSProperties}
        >
          {selected && (
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
                <p style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.5 }}>
                  {selected.description}
                </p>
              </div>
              <div className="sect">
                <h4>{t("governance.tools.schema")}</h4>
                <div className="code">{JSON.stringify(selected.inputSchema, null, 2)}</div>
              </div>
            </>
          )}
        </Panel>
      </div>

      <div className="gov-grid">
        <Panel
          title={`CEDAR — ${policyInfo?.engine.name ?? "launchpad_pe"}`}
          sub={t("governance.policy.sub")}
          end={
            policyInfo?.engine.attached ? (
              <Chip tone="amber" icon="◆">
                {policyInfo.engine.attached_mode === "ENFORCE"
                  ? t("governance.policy.enforced")
                  : "LOG_ONLY"}
              </Chip>
            ) : (
              <Chip tone="muted" icon="○">—</Chip>
            )
          }
          style={{ "--i": 4 } as CSSProperties}
        >
          <div className="code" style={{ maxHeight: 240, overflowY: "auto" }}>
            {policyInfo?.policies.map((p) => `// ${p.name} · ${p.status}\n${p.statement}`).join("\n\n") ??
              t("governance.policy.loading")}
          </div>
          <div style={{ display: "flex", gap: 9, marginTop: 12, flexWrap: "wrap" }}>
            <Btn disabled={testBusy} onClick={() => void runPolicyTest("demo")}>
              {t("governance.policy.testAnalyst")}
            </Btn>
            <Btn disabled={testBusy} onClick={() => void runPolicyTest("river")}>
              {t("governance.policy.testAdmin")}
            </Btn>
            <Btn onClick={() => void runGeneration()}>{t("governance.policy.generate")}</Btn>
          </div>
          {genOut && (
            <div className="code" style={{ marginTop: 10, maxHeight: 160, overflowY: "auto" }}>
              {genOut}
            </div>
          )}
        </Panel>

        <Panel
          className="dlog"
          title={t("governance.decisions.title")}
          sub={t("governance.decisions.sub")}
          pad={false}
          style={{ "--i": 5 } as CSSProperties}
        >
          {decisions.length === 0 && <div className="empty">{t("governance.decisions.empty")}</div>}
          {decisions.slice(0, 8).map((d, i) => (
            <div className="row" key={i}>
              <span className="t">{d.at?.slice(11, 19)}</span>
              <span className="who">{d.principal}</span>
              <span className="res">{d.tool.replace("hr-database___", "hr-database.")}</span>
              {d.outcome === "ALLOW" ? (
                <Chip tone="good" icon="✓">ALLOW</Chip>
              ) : (
                <Chip tone="crit" icon="✕">DENY</Chip>
              )}
            </div>
          ))}
        </Panel>
      </div>

      <div className="gov-grid">
        <Panel
          title={t("governance.demos.ciTitle")}
          sub="aws.codeinterpreter.v1"
          style={{ "--i": 2 } as CSSProperties}
          end={
            <Btn primary disabled={ciBusy} onClick={() => void runCodeDemo()}>
              {ciBusy ? "…" : `▸ ${t("governance.demos.run")}`}
            </Btn>
          }
        >
          <div className="code" data-testid="ci-out">
            <span className="k2">import</span> math{"\n"}
            <span className="k2">print</span>(&#39;sqrt(1764) =&#39;, math.isqrt(1764))
            {ciOut && (
              <>
                {"\n\n"}
                <span className="k1">{ciOut}</span>
              </>
            )}
          </div>
        </Panel>
        <Panel
          title={t("governance.demos.brTitle")}
          sub="aws.browser.v1"
          style={{ "--i": 3 } as CSSProperties}
          end={
            <Btn primary disabled={brBusy} onClick={() => void runBrowserDemo()}>
              {brBusy ? "…" : `▸ ${t("governance.demos.run")}`}
            </Btn>
          }
        >
          <div className="code" data-testid="br-out">
            GET https://example.com → title?
            {brOut && (
              <>
                {"\n\n"}
                <span className="k1">{brOut}</span>
              </>
            )}
          </div>
        </Panel>
      </div>
    </section>
  );
}

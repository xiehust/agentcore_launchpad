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

export function Governance() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<ToolInfo | null>(null);
  const [ciOut, setCiOut] = useState<string>("");
  const [ciBusy, setCiBusy] = useState(false);
  const [brOut, setBrOut] = useState<string>("");
  const [brBusy, setBrBusy] = useState(false);

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
  }, []);

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

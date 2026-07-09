import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Chip, DataTable, Panel, StatTile, ViewHead } from "../components";
import type { ChipTone } from "../components";
import type { AgentInfo } from "../lib/api";
import { api } from "../lib/api";

const SERVICES = [
  "runtime",
  "gateway",
  "memory",
  "registry",
  "policy",
  "evaluation",
  "observability",
] as const;

const METHOD_CHIP: Record<string, { tone: ChipTone; icon: string; label: string }> = {
  harness: { tone: "amber", icon: "◇", label: "HARNESS" },
  container: { tone: "blue", icon: "▣", label: "CLAUDE SDK" },
  zip_runtime: { tone: "aqua", icon: "⬡", label: "STRANDS" },
  studio: { tone: "aqua", icon: "⬡", label: "STUDIO" },
};

function useAgents(intervalMs = 5000): AgentInfo[] {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listAgents()
        .then((res) => {
          if (alive) setAgents(res.agents);
        })
        .catch(() => {
          /* backend offline — feed stays empty */
        });
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return agents;
}

function ageOf(iso: string | null, now: number): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function stageSummary(agent: AgentInfo): string {
  const stages = agent.deployment?.stages ?? [];
  const failed = stages.find((s) => s.status === "failed");
  if (failed) return `${failed.name} ✕ ${failed.detail}`.slice(0, 60);
  const running = stages.find((s) => s.status === "running");
  if (running) return `${running.name} ◐`;
  const doneCount = stages.filter(
    (s) => s.status === "succeeded" || s.status === "skipped",
  ).length;
  if (doneCount === stages.length && stages.length > 0) return "register ✓";
  return stages.length ? `${doneCount}/${stages.length}` : "—";
}

export function Overview() {
  const { t } = useTranslation();
  const agents = useAgents();
  const now = Date.now();
  const active = agents.filter((a) => a.status === "active").length;

  return (
    <section>
      <ViewHead
        kicker={t("overview.kicker")}
        title={t("overview.title")}
        meta={t("overview.meta")}
      />

      <div className="tiles">
        <StatTile
          label={t("overview.tiles.deployedAgents")}
          value={String(active)}
          foot={
            agents.length > active
              ? t("overview.tiles.inFlight", { count: agents.length - active })
              : t("overview.tiles.none")
          }
          style={{ "--i": 0 } as CSSProperties}
        />
        <StatTile
          label={t("overview.tiles.activeSessions")}
          value="0"
          foot={t("overview.tiles.none")}
          style={{ "--i": 1 } as CSSProperties}
        />
        <StatTile
          label={t("overview.tiles.registryAssets")}
          value="0"
          foot={t("overview.tiles.breakdownEmpty")}
          style={{ "--i": 2 } as CSSProperties}
        />
        <StatTile
          label={t("overview.tiles.evalPassRate")}
          value="—"
          foot={t("overview.tiles.noRuns")}
          style={{ "--i": 3 } as CSSProperties}
        />
      </div>

      <div className="grid-2">
        <Panel
          brk
          title={t("overview.feed.title")}
          sub={t("overview.feed.sub")}
          pad={false}
          style={{ "--i": 4 } as CSSProperties}
        >
          <DataTable
            columns={[
              { key: "agent", label: t("overview.feed.agent") },
              { key: "method", label: t("overview.feed.method") },
              { key: "stage", label: t("overview.feed.stage") },
              { key: "status", label: t("overview.feed.status") },
              { key: "arn", label: t("overview.feed.runtimeArn") },
              { key: "age", label: t("overview.feed.age") },
            ]}
            isEmpty={agents.length === 0}
            empty={
              <Link to="/create" style={{ color: "var(--ink-3)" }}>
                {t("overview.feed.empty")}
              </Link>
            }
          >
            {agents.map((agent) => {
              const method = METHOD_CHIP[agent.method] ?? METHOD_CHIP.harness;
              return (
                <tr key={agent.id}>
                  <td className="pri">{agent.name}</td>
                  <td>
                    <Chip tone={method.tone} icon={method.icon}>
                      {method.label}
                    </Chip>
                  </td>
                  <td className="mono dim">{stageSummary(agent)}</td>
                  <td>
                    {agent.status === "active" ? (
                      <Chip tone="good" icon="●">
                        {t("status.active")}
                      </Chip>
                    ) : agent.status === "failed" ? (
                      <Chip tone="crit" icon="✕">
                        {t("status.failed")}
                      </Chip>
                    ) : (
                      <Chip tone="warn" icon="◐">
                        {t("status.deploying")}
                      </Chip>
                    )}
                  </td>
                  <td>
                    <span className="arn">{agent.arn ?? "—"}</span>
                  </td>
                  <td className="mono dim">{ageOf(agent.created_at, now)}</td>
                </tr>
              );
            })}
          </DataTable>
        </Panel>

        <Panel
          title={t("overview.health.title")}
          sub={t("overview.health.sub")}
          pad={false}
          style={{ "--i": 5 } as CSSProperties}
        >
          <div className="health">
            {SERVICES.map((svc) => (
              <div className="row" key={svc}>
                <span className={`led ${svc === "runtime" && active > 0 ? "g" : "off"}`}></span>
                <span className="nm">{t(`overview.health.${svc}`)}</span>
                <span className="st">
                  {svc === "runtime" && active > 0
                    ? t("overview.health.activeCount", { count: active })
                    : t("overview.health.pending")}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </section>
  );
}

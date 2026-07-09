import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { Chip, DataTable, Panel, StatTile, ViewHead } from "../components";

const SERVICES = [
  "runtime",
  "gateway",
  "memory",
  "registry",
  "policy",
  "evaluation",
  "observability",
] as const;

export function Overview() {
  const { t } = useTranslation();

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
          value="0"
          foot={t("overview.tiles.none")}
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
            isEmpty
            empty={t("overview.feed.empty")}
          />
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
                <span className="led off"></span>
                <span className="nm">{t(`overview.health.${svc}`)}</span>
                <span className="st">{t("overview.health.pending")}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <Chip tone="muted" icon="○">
        {t("common.phaseTag", { phase: 3 })}
      </Chip>
    </section>
  );
}

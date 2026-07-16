import {
  Activity,
  BookOpenCheck,
  Boxes,
  ListTree,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { Panel, ViewHead } from "../components";
import { AuditView } from "./governance/AuditView";
import { DecisionView } from "./governance/DecisionView";
import { GatewayDetailView } from "./governance/GatewayDetailView";
import { GatewayListView } from "./governance/GatewayListView";
import { PolicyEditorView } from "./governance/PolicyEditorView";
import { ToolsView } from "./governance/ToolsView";
import {
  governanceViewFromParam,
  type GovernanceView,
} from "./governance/types";

const NAV_ITEMS = [
  { view: "gateways", icon: ListTree },
  { view: "gateway", icon: Boxes, needsGateway: true },
  { view: "policy", icon: ShieldCheck, needsGateway: true },
  { view: "decisions", icon: Activity, needsGateway: true },
  { view: "audit", icon: ScrollText, needsGateway: true },
  { view: "tools", icon: BookOpenCheck },
] as const;

export function Governance() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = governanceViewFromParam(searchParams.get("view"));
  const gatewayId = searchParams.get("gateway") ?? "";
  const policyId = searchParams.get("policy") ?? undefined;

  const navigate = useCallback(
    (nextView: GovernanceView, nextGatewayId?: string, nextPolicyId?: string) => {
      const params = new URLSearchParams();
      if (nextView !== "gateways") params.set("view", nextView);
      const selectedGateway = nextGatewayId ?? gatewayId;
      if (selectedGateway && nextView !== "gateways" && nextView !== "tools") {
        params.set("gateway", selectedGateway);
      }
      if (nextView === "policy" && nextPolicyId) params.set("policy", nextPolicyId);
      setSearchParams(params);
    },
    [gatewayId, setSearchParams],
  );

  const gatewayRequired = !gatewayId && view !== "gateways" && view !== "tools";

  return (
    <section>
      <ViewHead
        kicker={t("governance.kicker")}
        title={t("governance.title")}
        meta={t(`governance.views.${view}`)}
      />

      <nav className="gov-nav" aria-label={t("governance.navLabel")}>
        {NAV_ITEMS.map(({ view: navView, icon: Icon, ...item }) => {
          const disabled = "needsGateway" in item && item.needsGateway && !gatewayId;
          return (
            <button
              key={navView}
              type="button"
              className={`gov-nav-item${view === navView ? " active" : ""}`}
              disabled={disabled}
              aria-current={view === navView ? "page" : undefined}
              title={disabled ? t("governance.gatewayRequired") : undefined}
              onClick={() => navigate(navView)}
            >
              <Icon size={14} aria-hidden="true" />
              {t(`governance.views.${navView}`)}
            </button>
          );
        })}
      </nav>

      {gatewayRequired ? (
        <Panel brk>
          <div className="gov-state gov-state-warn">
            <ShieldCheck size={20} aria-hidden="true" />
            <strong>{t("governance.gatewayRequired")}</strong>
            <button className="btn" type="button" onClick={() => navigate("gateways")}>
              {t("governance.actions.chooseGateway")}
            </button>
          </div>
        </Panel>
      ) : view === "gateway" ? (
        <GatewayDetailView gatewayId={gatewayId} onNavigate={navigate} />
      ) : view === "policy" ? (
        <PolicyEditorView
          gatewayId={gatewayId}
          policyId={policyId}
          onNavigate={navigate}
        />
      ) : view === "decisions" ? (
        <DecisionView gatewayId={gatewayId} onNavigate={navigate} />
      ) : view === "audit" ? (
        <AuditView gatewayId={gatewayId} onNavigate={navigate} />
      ) : view === "tools" ? (
        <ToolsView />
      ) : (
        <GatewayListView onOpen={(id) => navigate("gateway", id)} />
      )}
    </section>
  );
}

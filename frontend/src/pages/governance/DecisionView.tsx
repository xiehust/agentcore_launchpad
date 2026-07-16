import { ArrowLeft, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Btn, Chip, DataTable, Panel } from "../../components";
import {
  api,
  type GovernanceDecisionResponse,
  type GovernanceEvidenceRange,
  type GovernanceGatewayDetail,
  type GovernancePolicyListResponse,
} from "../../lib/api";
import {
  formatTimestamp,
  governanceError,
  statusTone,
  type GovernanceView,
} from "./types";

interface Props {
  gatewayId: string;
  onNavigate: (view: GovernanceView, gatewayId?: string, policyId?: string) => void;
}

const RANGES: GovernanceEvidenceRange[] = ["1h", "6h", "24h", "7d"];

export function DecisionView({ gatewayId, onNavigate }: Props) {
  const { t, i18n } = useTranslation();
  const [gateway, setGateway] = useState<GovernanceGatewayDetail | null>(null);
  const [policies, setPolicies] = useState<GovernancePolicyListResponse | null>(null);
  const [data, setData] = useState<GovernanceDecisionResponse | null>(null);
  const [range, setRange] = useState<GovernanceEvidenceRange>("24h");
  const [policyId, setPolicyId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (force = false) => {
      setRefreshing(true);
      setError(null);
      const [gatewayResult, policiesResult, decisionsResult] = await Promise.allSettled([
        api.getGovernanceGateway(gatewayId),
        api.listGovernancePolicies(gatewayId),
        api.governanceDecisions(gatewayId, range, policyId || undefined, force),
      ]);
      if (gatewayResult.status === "fulfilled") setGateway(gatewayResult.value);
      if (policiesResult.status === "fulfilled") setPolicies(policiesResult.value);
      if (decisionsResult.status === "fulfilled") {
        setData(decisionsResult.value);
      } else {
        setError(governanceError(decisionsResult.reason));
      }
      if (gatewayResult.status === "rejected") {
        setError(governanceError(gatewayResult.reason));
      }
      setRefreshing(false);
    },
    [gatewayId, policyId, range],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="gov-toolbar">
        <Btn onClick={() => onNavigate("gateway", gatewayId)}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t("governance.actions.back")}
        </Btn>
        <div className="gov-toolbar-title">
          <strong>{t("governance.decisions.title")}</strong>
          <span>{gateway?.name ?? gatewayId}</span>
        </div>
        <div className="range" aria-label={t("governance.decisions.range")}>
          {RANGES.map((value) => (
            <button
              type="button"
              key={value}
              className={range === value ? "on" : ""}
              onClick={() => setRange(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <Btn disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("governance.actions.refresh")}
        </Btn>
      </div>

      <Panel
        brk
        title={t("governance.decisions.awsTitle")}
        sub={t("governance.decisions.awsSource")}
        pad={false}
        end={
          <div className="gov-filter">
            <label htmlFor="governance-policy-filter">
              {t("governance.decisions.policy")}
            </label>
            <select
              id="governance-policy-filter"
              className="input"
              value={policyId}
              onChange={(event) => setPolicyId(event.target.value)}
            >
              <option value="">{t("governance.decisions.allPolicies")}</option>
              {policies?.policies.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {error ? (
          <div className="gov-state gov-state-error">
            <TriangleAlert size={20} aria-hidden="true" />
            <strong>{t("governance.states.unavailable")}</strong>
            <span>{error}</span>
            <Btn onClick={() => void load(true)}>{t("governance.actions.retry")}</Btn>
          </div>
        ) : data && !data.available ? (
          <div className="gov-state gov-state-warn">
            <TriangleAlert size={20} aria-hidden="true" />
            <strong>{t("governance.decisions.telemetryUnavailable")}</strong>
            <span>{data.unavailable_reason}</span>
          </div>
        ) : (
          <DataTable
            columns={[
              { key: "time", label: t("governance.decisions.time") },
              { key: "outcome", label: t("governance.decisions.outcome") },
              { key: "action", label: t("governance.decisions.action") },
              { key: "principal", label: t("governance.decisions.principal") },
              { key: "policy", label: t("governance.decisions.policy") },
              { key: "modes", label: t("governance.decisions.modes") },
              { key: "trace", label: t("governance.decisions.trace") },
            ]}
            isEmpty={!refreshing && (data?.decisions.length ?? 0) === 0}
            empty={t("governance.decisions.noAwsEvidence")}
          >
            {refreshing && !data ? (
              <tr>
                <td colSpan={7} className="loading-line">
                  {t("common.loading")}
                </td>
              </tr>
            ) : null}
            {data?.decisions.map((decision, index) => (
              <tr key={`${decision.at}-${decision.policy_id ?? "none"}-${index}`}>
                <td className="mono">
                  {formatTimestamp(decision.at, i18n.language)}
                  <div className="gov-cell-note">AWS</div>
                </td>
                <td>
                  <Chip tone={statusTone(decision.outcome)}>{decision.outcome}</Chip>
                </td>
                <td className="pri mono gov-break">{decision.action}</td>
                <td className="mono gov-break">{decision.principal}</td>
                <td className="mono">{decision.policy_id ?? "-"}</td>
                <td>
                  <div className="gov-action-list">
                    <Chip tone={statusTone(decision.engine_mode)}>
                      {decision.engine_mode ?? "-"}
                    </Chip>
                    <Chip tone={statusTone(decision.policy_mode)}>
                      {decision.policy_mode ?? "-"}
                    </Chip>
                  </div>
                </td>
                <td>
                  {decision.trace_id ? (
                    <Link
                      className="gov-text-link"
                      to={`/observability?trace=${encodeURIComponent(decision.trace_id)}`}
                    >
                      {decision.trace_id.slice(0, 8)}
                      <ExternalLink size={12} aria-hidden="true" />
                    </Link>
                  ) : decision.session_id ? (
                    <Link
                      className="gov-text-link"
                      to={`/observability?session=${encodeURIComponent(decision.session_id)}`}
                    >
                      {decision.session_id.slice(0, 8)}
                      <ExternalLink size={12} aria-hidden="true" />
                    </Link>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
        {data?.cache ? (
          <div className="gov-data-foot">
            <span>
              {t("governance.decisions.cache", {
                age: Math.round(data.cache.age_seconds),
              })}
            </span>
            <span>{t("governance.decisions.count", { count: data.count })}</span>
          </div>
        ) : null}
      </Panel>
    </>
  );
}

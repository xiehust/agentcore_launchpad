import { ArrowLeft, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, ConfirmDialog, DataTable, Panel, useToast } from "../../components";
import {
  api,
  type GovernanceAuditResponse,
  type GovernanceGatewayDetail,
  type GovernanceOperation,
  type GovernancePolicyChange,
} from "../../lib/api";
import {
  formatTimestamp,
  governanceError,
  isOperationPending,
  statusTone,
  type GovernanceView,
} from "./types";

interface Props {
  gatewayId: string;
  onNavigate: (view: GovernanceView, gatewayId?: string, policyId?: string) => void;
}

export function AuditView({ gatewayId, onNavigate }: Props) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const [gateway, setGateway] = useState<GovernanceGatewayDetail | null>(null);
  const [data, setData] = useState<GovernanceAuditResponse | null>(null);
  const [selected, setSelected] = useState<GovernancePolicyChange | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmationName, setConfirmationName] = useState("");
  const [sharedAcknowledged, setSharedAcknowledged] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [operation, setOperation] = useState<GovernanceOperation | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const [gatewayResult, auditResult] = await Promise.allSettled([
      api.getGovernanceGateway(gatewayId),
      api.governanceAudit(gatewayId),
    ]);
    if (gatewayResult.status === "fulfilled") setGateway(gatewayResult.value);
    if (auditResult.status === "fulfilled") {
      setData(auditResult.value);
      setSelected((current) => {
        if (!current) return auditResult.value.changes[0] ?? null;
        return (
          auditResult.value.changes.find((change) => change.id === current.id) ??
          auditResult.value.changes[0] ??
          null
        );
      });
    }
    if (gatewayResult.status === "rejected") {
      setError(governanceError(gatewayResult.reason));
    } else if (auditResult.status === "rejected") {
      setError(governanceError(auditResult.reason));
    }
    setRefreshing(false);
  }, [gatewayId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!operation || !isOperationPending(operation)) return;
    const timer = window.setTimeout(() => {
      void api
        .governanceOperation(operation.id)
        .then((next) => {
          setOperation(next);
          if (!isOperationPending(next)) void load();
        })
        .catch((pollError) => toast(governanceError(pollError), "crit"));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [load, operation, toast]);

  const needsSharedAck = (gateway?.shared_gateways.length ?? 0) > 1;
  const hasRollbackSnapshot =
    !!selected &&
    (selected.status === "succeeded" || selected.status === "partial") &&
    !!selected.policy_id &&
    ("policy" in selected.before ||
      "policies" in selected.before ||
      !!selected.candidate_policy_id);
  const rollbackReady =
    !!gateway &&
    !!selected?.policy_id &&
    hasRollbackSnapshot &&
    confirmationName === gateway.name &&
    (!needsSharedAck || sharedAcknowledged) &&
    !isOperationPending(operation);

  const rollback = async () => {
    if (!gateway || !selected?.policy_id || !rollbackReady) return;
    try {
      const [liveGateway, livePolicies] = await Promise.all([
        api.getGovernanceGateway(gateway.id),
        api.listGovernancePolicies(gateway.id),
      ]);
      const livePolicy = livePolicies.policies.find(
        (policy) => policy.id === selected.policy_id,
      );
      if (!livePolicy) {
        throw new Error(t("governance.policyEditor.policyNotFound"));
      }
      const next = await api.rollbackGovernancePolicy(
        liveGateway.id,
        selected.policy_id,
        {
          expected_gateway_updated_at: liveGateway.updated_at,
          expected_policy_updated_at: livePolicy.updated_at,
          acknowledged_gateway_ids:
            liveGateway.shared_gateways.length > 1
              ? liveGateway.shared_gateways.map((item) => item.id)
            : [],
          confirmation_name: confirmationName,
          evidence_range: "24h",
          audit_id: selected.id,
        },
      );
      setOperation(next);
      toast(t("governance.messages.requestAccepted"), "good");
    } catch (rollbackError) {
      toast(governanceError(rollbackError), "crit");
    } finally {
      setConfirmRollback(false);
    }
  };

  return (
    <>
      <div className="gov-toolbar">
        <Btn onClick={() => onNavigate("gateway", gatewayId)}>
          <ArrowLeft size={14} aria-hidden="true" />
          {t("governance.actions.back")}
        </Btn>
        <div className="gov-toolbar-title">
          <strong>{t("governance.audit.title")}</strong>
          <span>{gateway?.name ?? gatewayId}</span>
        </div>
        <Btn disabled={refreshing} onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
          {t("governance.actions.refresh")}
        </Btn>
      </div>

      {error ? (
        <Panel brk>
          <div className="gov-state gov-state-error">
            <TriangleAlert size={20} aria-hidden="true" />
            <strong>{t("governance.states.unavailable")}</strong>
            <span>{error}</span>
            <Btn onClick={() => void load()}>{t("governance.actions.retry")}</Btn>
          </div>
        </Panel>
      ) : (
        <div className="gov-audit-grid">
          <Panel
            brk
            title={t("governance.audit.journal")}
            sub={t("governance.audit.immutable")}
            pad={false}
          >
            <DataTable
              columns={[
                { key: "time", label: t("governance.audit.time") },
                { key: "operation", label: t("governance.audit.operation") },
                { key: "resource", label: t("governance.audit.resource") },
                { key: "operator", label: t("governance.audit.operator") },
                { key: "status", label: t("governance.audit.status") },
              ]}
              isEmpty={!refreshing && (data?.changes.length ?? 0) === 0}
              empty={t("governance.audit.empty")}
            >
              {refreshing && !data ? (
                <tr>
                  <td colSpan={5} className="loading-line">
                    {t("common.loading")}
                  </td>
                </tr>
              ) : null}
              {data?.changes.map((change) => (
                <tr
                  key={change.id}
                  className={`rowlink${selected?.id === change.id ? " sel" : ""}`}
                  tabIndex={0}
                  onClick={() => setSelected(change)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setSelected(change);
                  }}
                >
                  <td className="mono">
                    {formatTimestamp(change.created_at, i18n.language)}
                  </td>
                  <td className="pri">{change.operation}</td>
                  <td>
                    <div>{change.policy_id ?? change.engine_id ?? change.gateway_name}</div>
                    <div className="gov-cell-note mono">{change.id}</div>
                  </td>
                  <td className="mono">{change.operator}</td>
                  <td>
                    <Chip tone={statusTone(change.status)}>{change.status}</Chip>
                  </td>
                </tr>
              ))}
            </DataTable>
          </Panel>

          <Panel
            className="drawer"
            title={selected?.operation ?? t("governance.audit.details")}
            end={
              selected ? (
                <Chip tone={statusTone(selected.status)}>{selected.status}</Chip>
              ) : null
            }
            pad={false}
          >
            {selected ? (
              <>
                <div className="sect">
                  <div className="kv">
                    <span className="k">{t("governance.audit.gateway")}</span>
                    <span className="v">{selected.gateway_name}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("governance.audit.engine")}</span>
                    <span className="v gov-break">{selected.engine_id ?? "-"}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("governance.audit.policy")}</span>
                    <span className="v gov-break">{selected.policy_id ?? "-"}</span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("governance.audit.candidate")}</span>
                    <span className="v gov-break">
                      {selected.candidate_policy_id ?? "-"}
                    </span>
                  </div>
                  <div className="kv">
                    <span className="k">{t("governance.audit.override")}</span>
                    <span className="v">{selected.override_reason ?? "-"}</span>
                  </div>
                </div>
                <div className="sect">
                  <h4>{t("governance.audit.before")}</h4>
                  <pre className="code gov-code-wrap">
                    {JSON.stringify(selected.before, null, 2)}
                  </pre>
                </div>
                <div className="sect">
                  <h4>{t("governance.audit.requested")}</h4>
                  <pre className="code gov-code-wrap">
                    {JSON.stringify(selected.requested, null, 2)}
                  </pre>
                </div>
                <div className="sect">
                  <h4>{t("governance.audit.after")}</h4>
                  <pre className="code gov-code-wrap">
                    {JSON.stringify(selected.after, null, 2)}
                  </pre>
                </div>
                <div className="sect">
                  {needsSharedAck ? (
                    <div className="gov-alert gov-alert-warn">
                      <TriangleAlert size={15} aria-hidden="true" />
                      <div>
                        <ul>
                          {gateway?.shared_gateways.map((item) => (
                            <li key={item.id}>
                              {item.name} <span className="mono">{item.id}</span>
                            </li>
                          ))}
                        </ul>
                        <label className="gov-check-row">
                          <input
                            type="checkbox"
                            checked={sharedAcknowledged}
                            onChange={(event) =>
                              setSharedAcknowledged(event.target.checked)
                            }
                          />
                          <span>{t("governance.detail.sharedAck")}</span>
                        </label>
                      </div>
                    </div>
                  ) : null}
                  <div className="field">
                    <label>{t("governance.detail.confirmGatewayName")}</label>
                    <input
                      className="input mono"
                      value={confirmationName}
                      placeholder={gateway?.name}
                      onChange={(event) => setConfirmationName(event.target.value)}
                    />
                  </div>
                  {!hasRollbackSnapshot ? (
                    <div className="gov-inline-error">
                      {t("governance.audit.rollbackUnavailable")}
                    </div>
                  ) : null}
                  <Btn
                    disabled={!rollbackReady}
                    onClick={() => setConfirmRollback(true)}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t("governance.actions.rollback")}
                  </Btn>
                </div>
              </>
            ) : (
              <div className="empty">{t("governance.audit.select")}</div>
            )}
          </Panel>
        </div>
      )}

      {operation ? (
        <div className={`gov-operation gov-operation-${operation.status}`}>
          <Chip tone={statusTone(operation.status)}>{operation.status}</Chip>
          <span>{operation.operation}</span>
          <span className="mono">{operation.id}</span>
          {operation.error ? <strong>{operation.error}</strong> : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmRollback}
        title={t("governance.confirmTitles.rollback")}
        body={t("governance.confirm.rollbackAudit", {
          operation: selected?.operation,
          gateway: gateway?.name,
          policy: selected?.policy_id,
        })}
        confirmLabel={t("governance.actions.rollback")}
        onCancel={() => setConfirmRollback(false)}
        onConfirm={() => void rollback()}
      />
    </>
  );
}

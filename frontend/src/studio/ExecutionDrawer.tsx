// Local-debug execution drawer: run the active studio code in a backend
// subprocess and stream its stdout, with an AI Fix action on failure.
// Launchpad-styled; behavior ported from strands_studio_ui
// `src/components/execution-panel.tsx` (origin/main) minus history/artifacts.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, Play, Sparkles, Square } from "lucide-react";

import { Btn, Chip, useToast } from "../components";
import { AiFixPanel } from "./AiFixPanel";
import { useAiFix } from "./useAiFix";
import {
  executeCodeStream,
  getCodegenStatus,
  type DebugApiKeys,
  type FlowData,
} from "./lib/debug-client";

interface ExecutionDrawerProps {
  code: string;
  flowData: FlowData;
  graphMode: boolean;
  apiKeys: DebugApiKeys;
  onApplyFixedCode: (code: string) => boolean;
}

const INPUT_KEY = "launchpad_studio_exec_input";

type RunStatus = { kind: "ok" | "error" | "stopped"; ms: number; error?: string };

function readStoredInput(): string {
  try {
    return localStorage.getItem(INPUT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function ExecutionDrawer({
  code,
  flowData,
  graphMode,
  apiKeys,
  onApplyFixedCode,
}: ExecutionDrawerProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [inputData, setInputData] = useState(readStoredInput);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [codegen, setCodegen] = useState<{ available: boolean; reason?: string | null } | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const stoppedRef = useRef(false);
  const outRef = useRef<HTMLPreElement | null>(null);

  const aiFix = useAiFix({
    onApplied: (fixed) => {
      const applied = onApplyFixedCode(fixed);
      if (applied) toast(t("studio.fix.appliedToast"));
      return applied;
    },
  });

  // Codegen backend availability gates the Fix button (fetched once).
  useEffect(() => {
    let cancelled = false;
    getCodegenStatus()
      .then((s) => !cancelled && setCodegen({ available: s.available, reason: s.reason }))
      .catch(() => !cancelled && setCodegen({ available: false }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  // Abort any in-flight stream when the drawer unmounts (e.g. the debug pane is
  // closed mid-run) so we don't leak a reader or a backend subprocess.
  useEffect(() => () => abortRef.current?.abort(), []);

  const persistInput = (value: string) => {
    setInputData(value);
    try {
      localStorage.setItem(INPUT_KEY, value);
    } catch {
      /* storage disabled — best-effort */
    }
  };

  const run = async () => {
    if (!code.trim() || running) return;
    setOutput("");
    setRunStatus(null);
    aiFix.resetFixState();
    setRunning(true);
    stoppedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const start = Date.now();
    await executeCodeStream(
      { code, input_data: inputData.trim() || undefined, ...apiKeys },
      {
        onChunk: (chunk) => setOutput((prev) => prev + chunk),
        onComplete: (_final, timeS) => {
          setRunning(false);
          const ms = timeS != null ? Math.round(timeS * 1000) : Date.now() - start;
          setRunStatus({ kind: stoppedRef.current ? "stopped" : "ok", ms });
        },
        onError: (err, _partial, timeS) => {
          setRunning(false);
          const ms = timeS != null ? Math.round(timeS * 1000) : Date.now() - start;
          setRunStatus({ kind: "error", ms, error: err });
        },
        signal: controller.signal,
      },
    );
  };

  const stop = () => {
    stoppedRef.current = true;
    abortRef.current?.abort();
  };

  const handleAiFix = () => {
    if (aiFix.isFixing || runStatus?.kind !== "error") return;
    const errorText = [output, runStatus.error].filter((s) => s?.trim()).join("\n\n");
    aiFix.startFix({
      code,
      error: errorText,
      flow_data: flowData,
      graph_mode: graphMode,
      input_data: inputData.trim() || undefined,
    });
  };

  const fixEnabled = codegen?.available && !aiFix.isFixing && runStatus?.kind === "error";

  return (
    <div className="studio-exec">
      <div className="studio-exec-bar">
        <label className="studio-exec-lbl" htmlFor="studio-exec-input">
          {t("studio.exec.inputLabel")}
        </label>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {running ? (
            <Btn onClick={stop}>
              <Square size={12} /> {t("studio.exec.stop")}
            </Btn>
          ) : (
            <Btn primary onClick={() => void run()} disabled={!code.trim()}>
              <Play size={12} /> {t("studio.exec.run")}
            </Btn>
          )}
        </div>
      </div>

      <textarea
        id="studio-exec-input"
        className="input studio-exec-input"
        value={inputData}
        onChange={(e) => persistInput(e.target.value)}
        placeholder={t("studio.exec.inputPlaceholder")}
        rows={2}
        disabled={running}
      />

      <div className="studio-exec-outwrap">
        <pre className="studio-exec-out" ref={outRef}>
          {output || <span className="studio-exec-empty">{t("studio.exec.outputEmpty")}</span>}
          {running && <span className="caret" />}
        </pre>
      </div>

      <div className="studio-exec-foot">
        {runStatus?.kind === "ok" && (
          <Chip tone="good" icon="✓">
            {t("studio.exec.ok", { ms: runStatus.ms.toLocaleString() })}
          </Chip>
        )}
        {runStatus?.kind === "stopped" && (
          <Chip tone="muted" icon="■">
            {t("studio.exec.stopped")}
          </Chip>
        )}
        {runStatus?.kind === "error" && (
          <>
            <Chip tone="crit" icon="✕">
              {t("studio.exec.failed", { ms: runStatus.ms.toLocaleString() })}
            </Chip>
            <Btn onClick={handleAiFix} disabled={!fixEnabled} title={codegen?.reason ?? undefined}>
              {aiFix.isFixing ? (
                <Loader size={12} className="studio-spin" />
              ) : (
                <Sparkles size={12} />
              )}{" "}
              {codegen && !codegen.available
                ? t("studio.exec.fixUnavailable")
                : t("studio.fix.button")}
            </Btn>
          </>
        )}
      </div>

      <AiFixPanel
        isFixing={aiFix.isFixing}
        fixEvents={aiFix.fixEvents}
        fixError={aiFix.fixError}
        fixDiagnosis={aiFix.fixDiagnosis}
        fixApplied={aiFix.fixApplied}
        onDismissError={aiFix.resetFixState}
        onDismissDiagnosis={aiFix.dismissDiagnosis}
      />
    </div>
  );
}

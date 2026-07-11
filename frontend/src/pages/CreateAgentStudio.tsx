import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Edge, Node } from "@xyflow/react";

import { Btn, Chip, ConfirmDialog, LaunchSequence, Panel, useToast, ViewHead } from "../components";
import type { AgentInfo, AgentSpecInput, DeploymentInfo, JobInfo } from "../lib/api";
import { api, ApiError } from "../lib/api";
import { CodePanel } from "../studio/CodePanel";
import { FlowEditor } from "../studio/FlowEditor";
import { NodePalette } from "../studio/NodePalette";
import { PropertyPanel } from "../studio/PropertyPanel";
import { generateStrandsAgentCode } from "../studio/lib/code-generator";

const DRAFT_KEY = "launchpad_studio_draft";
const NAME_RE = /^[a-z][a-z0-9-]{2,47}$/;
const MAX_CODE = 200000;
const FALLBACK_PROMPT = "Strands Studio generated agent";

interface StudioFlow {
  nodes: Node[];
  edges: Edge[];
  graphMode: boolean;
}

// Mirror of the generator's findConnectedAgent: the execution agent is the
// agent/orchestrator/swarm reached from an input node, else the first one.
function executionAgent(nodes: Node[], edges: Edge[]): Node | null {
  const isExec = (n: Node) =>
    n.type === "agent" || n.type === "orchestrator-agent" || n.type === "swarm";
  for (const input of nodes.filter((n) => n.type === "input")) {
    for (const edge of edges.filter((e) => e.source === input.id)) {
      const target = nodes.find((n) => n.id === edge.target);
      if (target && isExec(target)) return target;
    }
  }
  return nodes.find(isExec) ?? null;
}

export function CreateAgentStudio() {
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editAgentId = params.get("agent");
  const editing = !!editAgentId;

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graphMode, setGraphMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);

  // Edit-mode state
  const [editAgent, setEditAgent] = useState<AgentInfo | null>(null);
  const [noFlowNotice, setNoFlowNotice] = useState(false);
  const [readonlyCode, setReadonlyCode] = useState<string | null>(null);

  // Publish / launch state
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishName, setPublishName] = useState("");
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [launch, setLaunch] = useState<{ agentId: string; jobId: string } | null>(null);
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [agentStatus, setAgentStatus] = useState("deploying");

  const selectedNode = selectedId ? (nodes.find((n) => n.id === selectedId) ?? null) : null;

  // Live code generation drives the drawer + the publish summary/guards.
  const genResult = useMemo(
    () => generateStrandsAgentCode(nodes, edges, graphMode),
    [nodes, edges, graphMode],
  );
  const fullCode = genResult.imports.join("\n") + "\n\n" + genResult.code;
  const extraReqs = useMemo(
    () =>
      nodes.some((n) => (n.data as { modelProvider?: string })?.modelProvider === "OpenAI")
        ? ["strands-agents[openai]"]
        : [],
    [nodes],
  );

  // ── edit mode: load the stored flow (or fall back for external-app agents) ──
  useEffect(() => {
    if (!editAgentId) return;
    let cancelled = false;
    api
      .getAgent(editAgentId)
      .then((agent) => {
        if (cancelled) return;
        if (agent.method !== "studio") {
          toast("That agent was not created with Strands Studio.");
          navigate("/create");
          return;
        }
        setEditAgent(agent);
        setPublishName(agent.name);
        const spec = (agent.spec ?? {}) as { studio_flow?: StudioFlow; code?: string };
        const flow = spec.studio_flow;
        if (flow && Array.isArray(flow.nodes) && flow.nodes.length > 0) {
          setNodes(flow.nodes);
          setEdges(Array.isArray(flow.edges) ? flow.edges : []);
          setGraphMode(!!flow.graphMode);
        } else {
          // Studio agent published by the standalone app: no canvas graph stored.
          setNoFlowNotice(true);
          if (typeof spec.code === "string") {
            setReadonlyCode(spec.code);
            setCodeOpen(true);
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        toast("Could not load that agent.");
        navigate("/create");
      });
    return () => {
      cancelled = true;
    };
  }, [editAgentId, navigate, toast]);

  // ── new-agent mode: restore then autosave a localStorage draft ──
  const restoredRef = useRef(false);
  useEffect(() => {
    if (editing || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as Partial<StudioFlow>;
      if (Array.isArray(draft.nodes)) setNodes(draft.nodes);
      if (Array.isArray(draft.edges)) setEdges(draft.edges);
      setGraphMode(!!draft.graphMode);
    } catch {
      /* corrupt draft — start clean */
    }
  }, [editing]);

  useEffect(() => {
    if (editing) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ nodes, edges, graphMode }));
      } catch {
        /* storage full/disabled — draft is best-effort */
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [nodes, edges, graphMode, editing]);

  // ── deploy polling (identical shape to the wizard's step 3) ──
  const failureToasted = useRef(false);
  const poll = useCallback(async () => {
    if (!launch) return;
    try {
      const agent = await api.getAgent(launch.agentId);
      setDeployment(agent.deployments?.[0] ?? null);
      setJob(await api.getJob(launch.jobId));
      if (agent.status === "failed" && !failureToasted.current) {
        failureToasted.current = true;
        const failedStage = (agent.deployments?.[0]?.stages ?? []).find(
          (s) => s.status === "failed",
        );
        toast(
          `Publish failed at ${failedStage?.name ?? "deploy"}: ${(failedStage?.detail ?? "").slice(0, 120)}`,
        );
      }
      setAgentStatus(agent.status);
    } catch {
      /* transient poll errors retry on the next tick */
    }
  }, [launch, toast]);

  useEffect(() => {
    if (!launch) return;
    void poll();
    if (agentStatus === "active" || agentStatus === "failed") return;
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, [launch, agentStatus, poll]);

  const onUpdateNode = useCallback((nodeId: string, data: Record<string, unknown>) => {
    // PropertyPanel already merges {...node.data, [field]: value}, so replace.
    setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, data } : n)));
  }, []);

  const clearCanvas = () => {
    setNodes([]);
    setEdges([]);
    setSelectedId(null);
    setConfirmClear(false);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  };

  const openPublish = () => {
    if (genResult.errors.length > 0) {
      toast("Fix the code generation errors before publishing.");
      setCodeOpen(true);
      return;
    }
    setPublishErr(null);
    setPublishOpen(true);
  };

  const doPublish = async () => {
    setPublishErr(null);
    if (genResult.errors.length > 0) {
      setPublishErr("Code generation has errors. Close and fix the flow.");
      return;
    }
    if (fullCode.length > MAX_CODE) {
      setPublishErr(
        `Generated code is ${fullCode.length.toLocaleString()} chars, over the ${MAX_CODE.toLocaleString()} limit.`,
      );
      return;
    }
    const exec = executionAgent(nodes, edges);
    const rawPrompt = (exec?.data as { systemPrompt?: string })?.systemPrompt;
    const systemPrompt = (rawPrompt?.trim() ? rawPrompt : FALLBACK_PROMPT).slice(0, 20000);
    const name = editing ? (editAgent?.name ?? publishName) : publishName;
    const spec: AgentSpecInput = {
      name,
      method: "studio",
      system_prompt: systemPrompt,
      code: fullCode,
      memory: { short_term: false, long_term: false },
      studio_flow: { nodes, edges, graphMode },
      ...(extraReqs.length ? { requirements: extraReqs } : {}),
    };
    try {
      const res =
        editing && editAgent
          ? await api.redeployAgent(editAgent.id, spec)
          : await api.createAgent(spec);
      failureToasted.current = false;
      if (!editing) {
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {
          /* ignore */
        }
      }
      setPublishOpen(false);
      setLaunch({ agentId: res.agent.id, jobId: res.job_id });
      setAgentStatus("deploying");
    } catch (err) {
      setPublishErr(err instanceof ApiError ? err.message : String(err));
    }
  };

  const nameValid = editing || NAME_RE.test(publishName);
  const canPublish = nodes.length > 0;
  const showReadonly = noFlowNotice && nodes.length === 0 && readonlyCode !== null;

  // ── launch view (replaces the canvas once a publish is in flight) ──
  if (launch) {
    return (
      <section>
        <ViewHead
          kicker="Agent management · Strands Studio"
          title={editing ? `Re-publishing ${editAgent?.name ?? ""}` : "Publishing agent"}
          meta="Deploying through the shared pipeline"
        />
        <LaunchSequence
          deployment={deployment}
          job={job}
          agentStatus={agentStatus}
          detailsMode={false}
          onRestart={() => navigate("/create")}
        />
        {agentStatus === "active" && (
          <>
            <div style={{ height: 14 }} />
            <Panel title="Agent published" sub="Runtime is active and registered">
              <div style={{ display: "flex", gap: 10 }}>
                <Link className="btn primary" to={`/chat?agent=${launch.agentId}`}>
                  Open chat ▸
                </Link>
                <Link className="btn" to="/create">
                  Back to agents
                </Link>
              </div>
            </Panel>
          </>
        )}
      </section>
    );
  }

  return (
    <section>
      <ViewHead
        kicker="Agent management · Strands Studio"
        title={editing ? `Edit ${editAgent?.name ?? "studio agent"}` : "Strands Studio"}
        meta="Compose a Strands agent on the canvas, then publish through the shared pipeline"
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
        }}
      >
        <Link className="btn" to="/create">
          ◂ Agents
        </Link>
        {editing && (
          <Chip tone="muted" icon="⟳">
            re-publish · {editAgent?.name ?? ""}
          </Chip>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          <Btn onClick={() => setCodeOpen((v) => !v)}>{codeOpen ? "Hide code" : "Generate code"}</Btn>
          <Btn onClick={() => setConfirmClear(true)} disabled={nodes.length === 0 && edges.length === 0}>
            Clear canvas
          </Btn>
          <Btn primary onClick={openPublish} disabled={!canPublish}>
            ▲ {editing ? "Re-publish" : "Publish"}
          </Btn>
        </div>
      </div>

      {noFlowNotice && (
        <div className="note" style={{ borderColor: "var(--amber)", marginBottom: 14 }}>
          <span className="i" style={{ color: "var(--amber)" }}>
            [i]
          </span>
          <span>
            This agent was created in the standalone studio, so no canvas graph is stored. Build a
            flow below to enable re-publish; the current deployed code is shown read-only until then.
          </span>
        </div>
      )}

      <div className={`studio-layout${selectedNode ? "" : " no-prop"}`}>
        <NodePalette />
        <div className="studio-canvas">
          <FlowEditor
            nodes={nodes}
            onNodesChange={setNodes}
            edges={edges}
            onEdgesChange={setEdges}
            graphMode={graphMode}
            onGraphModeChange={setGraphMode}
            onNodeSelect={(node) => setSelectedId(node?.id ?? null)}
            onInvalidConnection={(message) => toast(message)}
          />
        </div>
        {selectedNode && (
          <PropertyPanel
            selectedNode={selectedNode}
            onClose={() => setSelectedId(null)}
            onUpdateNode={onUpdateNode}
            nodes={nodes}
            edges={edges}
          />
        )}
      </div>

      {codeOpen && (
        <>
          <div style={{ height: 14 }} />
          {showReadonly ? (
            <Panel title="Deployed code (read-only)" sub="Build a flow to regenerate and re-publish">
              <pre className="code" style={{ maxHeight: 420, overflow: "auto", margin: 0 }}>
                {readonlyCode}
              </pre>
            </Panel>
          ) : (
            <CodePanel nodes={nodes} edges={edges} graphMode={graphMode} />
          )}
        </>
      )}

      {publishOpen && (
        <div className="confirm-backdrop" onClick={() => setPublishOpen(false)}>
          <div
            className="confirm-box"
            role="dialog"
            aria-modal="true"
            aria-label="Publish agent"
            style={{ maxWidth: 520, width: "92%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-title">▲ {editing ? "Re-publish agent" : "Publish agent"}</div>

            {editing ? (
              <div className="field">
                <label>Name</label>
                <input className="input mono" value={editAgent?.name ?? publishName} disabled />
              </div>
            ) : (
              <div className="field">
                <label htmlFor="studio-name">Agent name</label>
                <input
                  id="studio-name"
                  className="input mono"
                  value={publishName}
                  onChange={(e) => setPublishName(e.target.value)}
                  placeholder="studio-canvas-agent"
                  autoFocus
                />
                {publishName.length > 0 && !nameValid && (
                  <div className="studio-warn" style={{ color: "var(--crit)" }}>
                    Lowercase letters, digits and hyphens; 3–48 chars, must start with a letter.
                  </div>
                )}
              </div>
            )}

            <div className="kv">
              <span className="k">Generated code</span>
              <span className="v">
                {fullCode.length.toLocaleString()} chars · {fullCode.split("\n").length} lines
              </span>
            </div>
            <div className="kv">
              <span className="k">Extra requirements</span>
              <span className="v">{extraReqs.length ? extraReqs.join(", ") : "none"}</span>
            </div>
            <div className="kv">
              <span className="k">Memory</span>
              <span className="v">short_term off · long_term off</span>
            </div>

            {publishErr && (
              <div className="note" style={{ borderColor: "var(--crit)", marginTop: 12 }}>
                <span className="i" style={{ color: "var(--crit)" }}>
                  [✕]
                </span>
                <span>{publishErr}</span>
              </div>
            )}

            <div className="confirm-actions" style={{ marginTop: 16 }}>
              <Btn onClick={() => setPublishOpen(false)}>Cancel</Btn>
              <Btn primary disabled={!nameValid} onClick={() => void doPublish()}>
                ▲ {editing ? "Re-publish" : "Publish"}
              </Btn>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear canvas"
        body="Remove all nodes and edges from the canvas? This also clears the saved draft."
        confirmLabel="Clear"
        onConfirm={clearCanvas}
        onCancel={() => setConfirmClear(false)}
      />
    </section>
  );
}

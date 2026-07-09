import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Btn, Chip, Panel, ViewHead } from "../components";
import type { AgentInfo } from "../lib/api";
import { api } from "../lib/api";

interface Message {
  kind: "user" | "agent" | "tool" | "memory" | "error";
  text: string;
  name?: string;
  streaming?: boolean;
}

interface MemorySummary {
  event_count: number;
  records: { namespace: string; text: string }[];
}

interface KeyInfo {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  key?: string;
}

async function* sseEvents(res: Response): AsyncGenerator<{ event: string; data: never }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) as never };
    }
  }
}

export function Chat() {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentId, setAgentId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [memory, setMemory] = useState<MemorySummary | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [newKey, setNewKey] = useState<KeyInfo | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .listAgents()
      .then((res) => {
        const active = res.agents.filter((a) => a.status === "active");
        setAgents(active);
        if (active.length && !agentId) setAgentId(active[0].id);
      })
      .catch(() => {});
    void loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  const loadKeys = async () => {
    try {
      const res = await fetch("/api/apikeys");
      if (res.ok) setKeys(((await res.json()) as { keys: KeyInfo[] }).keys);
    } catch {
      /* offline */
    }
  };

  const refreshMemory = async (sid: string) => {
    try {
      const res = await fetch(`/api/chat/${agentId}/memory?session_id=${sid}&actor_id=river`);
      if (res.ok) setMemory((await res.json()) as MemorySummary);
    } catch {
      /* memory rail is best-effort */
    }
  };

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || !agentId || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { kind: "user", text: prompt }]);
    try {
      const res = await fetch(`/api/chat/${agentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, session_id: sessionId, actor_id: "river" }),
      });
      if (!res.ok || !res.body) throw new Error(`http ${res.status}`);
      let agentIdxSet = false;
      for await (const { event, data } of sseEvents(res)) {
        const payload = data as {
          session_id?: string;
          text?: string;
          name?: string;
          message?: string;
        };
        if (event === "meta" && payload.session_id) {
          setSessionId(payload.session_id);
        } else if (event === "tool") {
          setMessages((m) => [
            ...m,
            { kind: "tool", text: payload.name ?? "tool", name: payload.name },
          ]);
          agentIdxSet = false;
        } else if (event === "delta") {
          setMessages((m) => {
            const next = [...m];
            const last = next[next.length - 1];
            if (agentIdxSet && last?.kind === "agent") {
              next[next.length - 1] = { ...last, text: last.text + (payload.text ?? "") };
            } else {
              next.push({ kind: "agent", text: payload.text ?? "", streaming: true });
            }
            return next;
          });
          agentIdxSet = true;
        } else if (event === "error") {
          setMessages((m) => [...m, { kind: "error", text: payload.message ?? "error" }]);
        } else if (event === "done") {
          setMessages((m) =>
            m.map((msg, i) => (i === m.length - 1 ? { ...msg, streaming: false } : msg)),
          );
          setMessages((m) => [
            ...m,
            { kind: "memory", text: t("chatPage.memorySaved") },
          ]);
        }
      }
    } catch (err) {
      setMessages((m) => [...m, { kind: "error", text: String(err) }]);
    } finally {
      setBusy(false);
      if (sessionId) void refreshMemory(sessionId);
    }
  };

  useEffect(() => {
    if (sessionId && !busy) void refreshMemory(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, busy]);

  const newSession = () => {
    setSessionId(null);
    setMessages([]);
    setMemory(null);
  };

  const createKey = async () => {
    const res = await fetch("/api/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `console-${keys.length + 1}` }),
    });
    if (res.ok) {
      const created = (await res.json()) as KeyInfo;
      setNewKey(created);
      void loadKeys();
    }
  };

  const toggleKey = async (key: KeyInfo) => {
    await fetch(`/api/apikeys/${key.id}/${key.enabled ? "disable" : "enable"}`, {
      method: "POST",
    });
    void loadKeys();
  };

  const agent = agents.find((a) => a.id === agentId);

  return (
    <section>
      <ViewHead kicker={t("chat.kicker")} title={t("chat.title")} meta={t("chat.metaLive")} />

      <div className="chat-grid">
        <Panel
          brk
          pad={false}
          title={
            (
              <select
                value={agentId}
                onChange={(e) => {
                  setAgentId(e.target.value);
                  newSession();
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--line-2)",
                  color: "var(--ink)",
                  font: "inherit",
                  padding: "3px 8px",
                }}
                data-testid="agent-select"
              >
                {agents.length === 0 && <option value="">{t("chatPage.noAgents")}</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id} style={{ background: "#141816" }}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) as unknown as string
          }
          sub={agent ? agent.method.toUpperCase() : undefined}
          end={
            <>
              {sessionId && (
                <Chip tone="muted" className="mono">
                  session {sessionId.slice(0, 8)}…
                </Chip>
              )}
              <Chip tone="aqua" icon="◈">
                {t("chatPage.memoryOn")}
              </Chip>
              <Btn onClick={newSession}>{t("chatPage.newSession")}</Btn>
            </>
          }
          style={{ "--i": 0 } as CSSProperties}
        >
          <div className="thread" ref={threadRef} data-testid="thread">
            {messages.length === 0 && (
              <div className="empty">{t("chatPage.emptyThread")}</div>
            )}
            {messages.map((msg, i) =>
              msg.kind === "user" ? (
                <div key={i} className="msg user">
                  <div className="who">RIVER</div>
                  <div className="bub">{msg.text}</div>
                </div>
              ) : msg.kind === "agent" ? (
                <div key={i} className="msg agent">
                  <div className="who">
                    {agent?.name.toUpperCase() ?? "AGENT"}
                    {msg.streaming ? " · STREAMING" : ""}
                  </div>
                  <div className="bub">
                    {msg.text}
                    {msg.streaming && <span className="caret" />}
                  </div>
                </div>
              ) : msg.kind === "tool" ? (
                <div key={i} className="toolcard">
                  <span className="tc-ic">⇄</span>
                  {msg.name}
                  <Chip tone="good" icon="✓" style={{ marginLeft: "auto" }}>
                    {t("chatPage.toolCalled")}
                  </Chip>
                </div>
              ) : msg.kind === "memory" ? (
                <div key={i} className="memline">
                  <i>◈</i> {msg.text}
                </div>
              ) : (
                <div key={i} className="note" style={{ borderColor: "var(--crit)" }}>
                  <span className="i" style={{ color: "var(--crit)" }}>
                    [✕]
                  </span>
                  <span className="mono">{msg.text}</span>
                </div>
              ),
            )}
          </div>
          <div className="chatbar">
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void send()}
              placeholder={agent ? t("chatPage.placeholder", { name: agent.name }) : "…"}
              disabled={busy || !agentId}
              data-testid="chat-input"
            />
            <Btn primary disabled={busy || !agentId} onClick={() => void send()}>
              {t("chatPage.send")} ▸
            </Btn>
          </div>
        </Panel>

        <div>
          <Panel title={t("chatPage.traceTitle")} sub={t("chatPage.tracePhase9")} style={{ "--i": 1 } as CSSProperties}>
            <div className="empty">{t("chatPage.tracePlaceholder")}</div>
          </Panel>
          <div style={{ height: 14 }} />
          <Panel title={t("chatPage.memoryTitle")} style={{ "--i": 2 } as CSSProperties}>
            <div className="kv">
              <span className="k">{t("chatPage.shortTermEvents")}</span>
              <span className="v">{memory?.event_count ?? 0}</span>
            </div>
            <div className="kv">
              <span className="k">{t("chatPage.longTermRecords")}</span>
              <span className="v">{memory?.records.length ?? 0}</span>
            </div>
            {memory && memory.records.length > 0 && (
              <div className="code" style={{ marginTop: 10, maxHeight: 140, overflowY: "auto" }}>
                {memory.records.map((r, i) => (
                  <div key={i}>
                    <span className="cm">{r.namespace}</span>
                    {"\n"}“{r.text}”{"\n"}
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <div style={{ height: 14 }} />
          <Panel title={t("chatPage.apiTitle")} style={{ "--i": 3 } as CSSProperties}>
            <div className="code">
              {`curl -N -X POST \\
  ${window.location.origin}/v1/agents/${agentId || "<id>"}/invoke-stream \\
  -H "x-api-key: lp_live_…" \\
  -d '{"prompt":"…","session_id":${sessionId ? `"${sessionId.slice(0, 8)}…"` : "null"}}'`}
            </div>
          </Panel>
          <div style={{ height: 14 }} />
          <Panel
            title={t("chatPage.keysTitle")}
            end={<Btn onClick={() => void createKey()}>+ {t("chatPage.newKey")}</Btn>}
            style={{ "--i": 4 } as CSSProperties}
          >
            {newKey?.key && (
              <div className="note" style={{ marginBottom: 10 }}>
                <span className="i">[i]</span>
                <span className="mono" data-testid="new-key">
                  {t("chatPage.keyOnce")}: {newKey.key}
                </span>
              </div>
            )}
            {keys.length === 0 && <div className="empty">{t("chatPage.noKeys")}</div>}
            {keys.map((key) => (
              <div className="kv" key={key.id}>
                <span className="k mono">
                  {key.prefix} · {key.name}
                </span>
                <span className="v">
                  <button
                    type="button"
                    className={`selchip${key.enabled ? " on" : ""}`}
                    style={{ cursor: "pointer" }}
                    onClick={() => void toggleKey(key)}
                  >
                    {key.enabled ? t("chatPage.keyEnabled") : t("chatPage.keyDisabled")}
                  </button>
                </span>
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </section>
  );
}

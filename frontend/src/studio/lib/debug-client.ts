// Launchpad-authored (NOT a byte-faithful upstream port — unlike the other
// files in this directory). Typed client for the studio local-debug backend
// (execute / conversations / fix-code / codegen-status). The SSE decoders are
// ported from strands_studio_ui `src/lib/api-client.ts` (origin/main): the
// execute/chat streams use `data:`-framing where an empty `data: ` line means a
// newline; the fix stream is a JSON `event:`/`data:` stream. All paths are
// relative so Vite's dev proxy (and the same-origin prod build) reach :8000.
import { ApiError } from "../../lib/api";

/* ── shared shapes ─────────────────────────────────────────────────────── */

export interface FlowData {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}

export interface DebugApiKeys {
  openai_api_key?: string;
  bedrock_api_key?: string;
}

/* ── execution ─────────────────────────────────────────────────────────── */

export interface ExecuteRequest extends DebugApiKeys {
  code: string;
  input_data?: string;
}

export interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
  execution_time_ms: number;
}

export interface ExecuteStreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: (finalOutput: string, executionTime?: number) => void;
  onError: (error: string, partialOutput: string, executionTime?: number) => void;
  signal?: AbortSignal;
}

/* ── conversations ─────────────────────────────────────────────────────── */

export interface ConversationSession {
  session_id: string;
  project_id: string;
  version: string;
  agent_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  message_id: string;
  session_id: string;
  sender: "user" | "agent";
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationRequest extends DebugApiKeys {
  generated_code: string;
  flow_data?: FlowData;
}

export interface ChatStreamCallbacks {
  onChunk: (chunk: string) => void;
  onComplete: (finalOutput: string, messageId: string) => void;
  onError: (error: string, partialOutput: string) => void;
  signal?: AbortSignal;
}

/* ── codegen / AI fix ──────────────────────────────────────────────────── */

export interface CodegenStatus {
  available: boolean;
  reason?: string | null;
  backend?: string;
  model?: string;
}

export interface CodegenValidationError {
  stage: string;
  message: string;
}

export interface CodegenValidationReport {
  passed: boolean;
  errors: CodegenValidationError[];
}

export interface FixCodeRequest {
  code: string;
  error: string;
  flow_data: FlowData;
  graph_mode: boolean;
  input_data?: string;
}

export interface FixSuggestion {
  node_label?: string;
  property?: string;
  action: string;
}

export interface FixDiagnosis {
  category: "code" | "config" | "environment";
  summary: string;
  suggestions: FixSuggestion[];
}

export interface FixResult {
  code: string;
  changed: boolean;
  diagnosis: FixDiagnosis;
  validation_report?: CodegenValidationReport;
  duration_ms?: number;
}

export interface FixCodeStreamCallbacks {
  onProgress?: (message: string) => void;
  onAgentActivity?: (summary: string) => void;
  onValidation?: (round: number, errors: CodegenValidationError[]) => void;
  onDone: (result: FixResult) => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}

/* ── plain JSON request (launchpad {code,message} error envelope) ──────── */

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const env = (body ?? {}) as { code?: string; message?: string; detail?: unknown };
    throw new ApiError(env.code ?? `http.${res.status}`, env.message ?? res.statusText, env.detail);
  }
  return body as T;
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (error instanceof DOMException && error.name === "AbortError");
}

/* ── execute: one-shot + streaming ─────────────────────────────────────── */

export function executeCode(request: ExecuteRequest): Promise<ExecuteResult> {
  return jsonRequest<ExecuteResult>("/api/execute", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

// Streamed execution. Framing (upstream-faithful): SSE events split on \n\n;
// within an event each `data: <text>` line is concatenated and an empty
// `data:`/`data: ` line becomes a newline, so multiline stdout survives the
// `data:` splitting. Sentinels: `[STREAM_COMPLETE]` / `[STREAM_COMPLETE:<sec>]`;
// an `Error: ` line is held until the completion sentinel so timing is kept.
export async function executeCodeStream(
  request: ExecuteRequest,
  { onChunk, onComplete, onError, signal }: ExecuteStreamCallbacks,
): Promise<void> {
  let accumulated = "";
  try {
    const response = await fetch("/api/execute/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Streaming request failed: ${response.status} ${response.statusText}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";
    let errorMessage: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        if (!event.trim()) continue;
        let eventData = "";
        const lines = event.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const chunk = line.substring(6);
            eventData += chunk === "" ? "\n" : chunk;
          } else if (line === "data:") {
            eventData += "\n";
          }
        }
        if (eventData === "" && !lines.some((l) => l === "data:" || l.startsWith("data: "))) {
          continue;
        }
        if (eventData === "[STREAM_COMPLETE]") {
          if (errorMessage) onError(errorMessage, accumulated);
          else onComplete(accumulated);
          return;
        }
        if (eventData.startsWith("[STREAM_COMPLETE:")) {
          const match = eventData.match(/^\[STREAM_COMPLETE:([\d.]+)\]$/);
          const executionTime = match ? parseFloat(match[1]) : undefined;
          if (errorMessage) onError(errorMessage, accumulated, executionTime);
          else onComplete(accumulated, executionTime);
          return;
        }
        if (eventData.startsWith("Error: ")) {
          errorMessage = eventData.substring(7);
        } else {
          accumulated += eventData;
          onChunk(eventData);
        }
      }
    }
    // Stream closed without a sentinel.
    if (errorMessage) onError(errorMessage, accumulated);
    else onComplete(accumulated);
  } catch (error) {
    if (isAbort(error, signal)) {
      onComplete(accumulated); // Stop button: keep whatever streamed so far.
      return;
    }
    onError(error instanceof Error ? error.message : "Unknown streaming error", accumulated);
  }
}

/* ── conversations CRUD ────────────────────────────────────────────────── */

export function createConversationSession(
  request: CreateConversationRequest,
): Promise<ConversationSession> {
  return jsonRequest<ConversationSession>("/api/conversations", {
    method: "POST",
    body: JSON.stringify(request),
  });
}

export function updateConversationCode(
  sessionId: string,
  generatedCode: string,
): Promise<ConversationSession> {
  return jsonRequest<ConversationSession>(`/api/conversations/${sessionId}/code`, {
    method: "PUT",
    body: JSON.stringify({ generated_code: generatedCode }),
  });
}

export async function getConversationMessages(sessionId: string): Promise<ChatMessage[]> {
  const res = await jsonRequest<{ messages: ChatMessage[] }>(
    `/api/conversations/${sessionId}/messages`,
  );
  return res.messages;
}

export function deleteConversationSession(sessionId: string): Promise<{ message: string }> {
  return jsonRequest<{ message: string }>(`/api/conversations/${sessionId}`, { method: "DELETE" });
}

// Streamed chat turn. Same `data:`-framing as execute, plus two single-line
// sentinels: `[CHAT_ERROR:<json-string>]` (JSON keeps a multiline traceback on
// one SSE line) and `[CHAT_COMPLETE:<message_id>]`.
export async function sendChatMessageStream(
  sessionId: string,
  message: string,
  { onChunk, onComplete, onError, signal }: ChatStreamCallbacks,
): Promise<void> {
  let accumulated = "";
  try {
    const response = await fetch(`/api/conversations/${sessionId}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stream: true }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Streaming chat request failed: ${response.status} ${response.statusText}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    const decoder = new TextDecoder();
    let buffer = "";
    let errorMessage: string | null = null;
    let messageId = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        if (!event.trim()) continue;
        let eventData = "";
        const lines = event.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const chunk = line.substring(6);
            eventData += chunk === "" ? "\n" : chunk;
          } else if (line === "data:") {
            eventData += "\n";
          }
        }
        if (eventData === "" && !lines.some((l) => l === "data:" || l.startsWith("data: "))) {
          continue;
        }
        if (eventData.startsWith("[CHAT_ERROR:")) {
          const match = eventData.match(/^\[CHAT_ERROR:([\s\S]+)\]$/);
          if (match) {
            try {
              errorMessage = JSON.parse(match[1]) as string;
            } catch {
              errorMessage = match[1];
            }
          } else {
            errorMessage = eventData;
          }
        } else if (eventData.startsWith("[CHAT_COMPLETE:")) {
          const match = eventData.match(/^\[CHAT_COMPLETE:([^\]]+)\]$/);
          messageId = match ? match[1] : "";
          if (errorMessage) onError(errorMessage, accumulated);
          else onComplete(accumulated, messageId);
          return;
        } else if (eventData.startsWith("Error: ")) {
          errorMessage = eventData.substring(7);
        } else {
          accumulated += eventData;
          onChunk(eventData);
        }
      }
    }
    // Stream ended without a [CHAT_COMPLETE:] marker (backend fallback path may
    // yield only [CHAT_ERROR:...] before closing).
    if (errorMessage) onError(errorMessage, accumulated);
    else onComplete(accumulated, messageId);
  } catch (error) {
    if (isAbort(error, signal)) {
      onComplete(accumulated, "");
      return;
    }
    onError(error instanceof Error ? error.message : "Unknown streaming error", accumulated);
  }
}

/* ── codegen: status + AI fix (JSON event/data SSE) ────────────────────── */

export function getCodegenStatus(): Promise<CodegenStatus> {
  return jsonRequest<CodegenStatus>("/api/generate-code/status");
}

// Shared SSE POST parser: `event:`/`data:` framing, JSON payloads. Calls
// onEvent(eventType, dataText) for every complete event.
async function postSseStream(
  path: string,
  body: unknown,
  onEvent: (eventType: string, dataText: string) => void,
  requestLabel: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`${requestLabel} request failed: ${response.status} ${response.statusText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is not readable");

  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const rawEvent of events) {
      if (!rawEvent.trim()) continue;
      let eventType = "message";
      const dataLines: string[] = [];
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.substring(7).trim();
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.substring(6));
        } else if (line === "data:") {
          dataLines.push("");
        }
      }
      onEvent(eventType, dataLines.join("\n"));
    }
  }
}

// Dispatcher for the codegen SSE vocabulary (progress / agent_activity /
// validation / done / error / end).
async function runCodegenSseStream<TDone>(
  path: string,
  body: unknown,
  callbacks: {
    onProgress?: (message: string) => void;
    onAgentActivity?: (summary: string) => void;
    onValidation?: (round: number, errors: CodegenValidationError[]) => void;
    onDone: (result: TDone) => void;
    onError: (message: string) => void;
  },
  context: string,
  signal?: AbortSignal,
): Promise<void> {
  const { onProgress, onAgentActivity, onValidation, onDone, onError } = callbacks;
  const unknownError = `Unknown ${context.toLowerCase()} error`;
  let doneReceived = false;
  let errorReceived = false;

  const handleEvent = (eventType: string, dataText: string) => {
    if (eventType === "end") return;
    let data: Record<string, unknown> = {};
    if (dataText) {
      try {
        data = JSON.parse(dataText) as Record<string, unknown>;
      } catch {
        return; // Non-JSON payload (e.g. empty end-event data) — ignore.
      }
    }
    switch (eventType) {
      case "progress":
        onProgress?.(String(data.message ?? ""));
        break;
      case "agent_activity":
        onAgentActivity?.(String(data.summary ?? ""));
        break;
      case "validation":
        onValidation?.(
          Number(data.round ?? 0),
          (data.errors as CodegenValidationError[]) || [],
        );
        break;
      case "done":
        doneReceived = true;
        onDone(data as unknown as TDone);
        break;
      case "error":
        errorReceived = true;
        onError(String(data.message ?? unknownError));
        break;
    }
  };

  try {
    await postSseStream(path, body, handleEvent, context, signal);
    if (!doneReceived && !errorReceived) onError(`${context} stream ended unexpectedly`);
  } catch (error) {
    if (isAbort(error, signal)) return; // Explicit stop — no error surfaced.
    if (!doneReceived && !errorReceived) {
      onError(error instanceof Error ? error.message : unknownError);
    }
  }
}

export function fixCodeStream(
  request: FixCodeRequest,
  callbacks: FixCodeStreamCallbacks,
): Promise<void> {
  const { signal, ...rest } = callbacks;
  return runCodegenSseStream<FixResult>("/api/fix-code/stream", request, rest, "Code fix", signal);
}

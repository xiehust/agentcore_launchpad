# Research: System-prompt caching, reasoning effort, streaming/max_tokens defaults, aws-knowledge MCP

- **Query**: Add (a) system-prompt caching, (b) Bedrock Claude reasoning-effort tiers, (c) streaming default ON + max_tokens 32000 to the Strands Studio code generator; confirm aws-knowledge MCP transport.
- **Scope**: mixed (internal code + strands 1.47 wheel source + LIVE Bedrock probes on account 434444145045, us-west-2)
- **Date**: 2026-07-11
- **Method**: `pip download strands-agents==1.47.0` unzipped + read; boto3 `bedrock-runtime.converse` probes in us-west-2. All probe output pasted below is verbatim. Temp files cleaned.

> NOTE: the venv at `/home/ubuntu/workspace/strands_ui/backend/.venv` is **strands-agents 1.9.0**, NOT 1.47. All 1.47 claims below come from the downloaded 1.47.0 wheel source; the venv was used only as a boto3/host runner and for a construction-time check.

---

## TL;DR — the four concrete answers

1. **System-prompt caching**: two working shapes in 1.47. `BedrockModel(cache_prompt="default")` still works but emits a `UserWarning` deprecation (functional, tiny diff, keeps `system_prompt` as a string). The non-deprecated path is the `SystemContentBlock` list form on `Agent(system_prompt=[...])`. **Both produce an identical converse request.** Short prompts (<~1024 tokens) are a **silent no-op** (no error). Recommendation + exact Python below.
2. **Reasoning effort (Bedrock Claude)**: the ONLY accepted shape is **`additionalModelRequestFields = {"output_config": {"effort": "<tier>"}}`**. Top-level `effort`, `thinking.adaptive.effort`, `reasoning_effort` are all `ValidationException`. Valid tiers are **model-version-dependent**: Sonnet 4.6 accepts `low/medium/high/max` (rejects `xhigh`); Sonnet 5 and Opus 4.8 accept `low/medium/high/xhigh/max`. Effort combines cleanly with `thinking:{type:adaptive}` and only produces reasoning when adaptive thinking is also present.
3. **Streaming / max_tokens**: streaming codegen gate is a single fallback at `code-generator.ts:852` (`executionAgentData.streaming || false`); it affects only the top-level execution agent (swarm always sync, sub-agents/tools never stream). `max_tokens=32000` is valid for all Claude + gpt-oss/qwen/deepseek, but **breaks Nova Pro (hard cap 10000)** and sits exactly at Nova Premier's cap (32000). Full location list + backward-compat note below.
4. **aws-knowledge MCP**: `https://knowledge-mcp.global.api.aws` speaks streamable-HTTP MCP with **no auth**; `initialize` returns `serverInfo.name = "AWSKnowledgeMCP" v1.0.0`. Sample node: `transportType: 'streamable_http'`, `url: 'https://knowledge-mcp.global.api.aws'`.

---

## 1. System-prompt caching in strands-agents 1.47.0

### 1a. `cache_prompt` is still a valid config key (deprecated, functional)

Wheel `strands/models/bedrock.py`:

- `BedrockConfig` still declares `cache_prompt: str | None` (line 141) with docstring "Cache point type for the system prompt (deprecated, use cache_config)".
- `format_request` (lines 279-284) still honours it:

```python
# Add cache point if configured (backwards compatibility)
if cache_prompt := self.config.get("cache_prompt"):
    warnings.warn(
        "cache_prompt is deprecated. Use SystemContentBlock with cachePoint instead.", UserWarning, stacklevel=3
    )
    system_blocks.append({"cachePoint": {"type": cache_prompt}})
```

So `BedrockModel(cache_prompt="default")` appends `{"cachePoint":{"type":"default"}}` after the system text blocks and prints a `UserWarning` **once per request build** (not at construction). Construction-time check (run against the venv strands, but the key survives `validate_config_keys` in 1.47 identically since it's a declared key):

```
construct OK, config has cache_prompt = default
warnings at construct: []          # warning fires at request time, not construct
```

### 1b. `SystemContentBlock` pattern (non-deprecated)

`Agent(system_prompt=...)` accepts `str | list[SystemContentBlock]` and runs it through `split_system_prompt` (`strands/types/content.py:123`):

```python
if isinstance(system_prompt, str):
    return system_prompt, [{"text": system_prompt}]
elif isinstance(system_prompt, list):
    text_parts = [block["text"] for block in system_prompt if "text" in block]
    system_prompt_str = "\n".join(text_parts) if text_parts else None
    return system_prompt_str, system_prompt
```

`SystemContentBlock` is a `TypedDict` with just `cachePoint` and `text` (`types/content.py:107`), so **plain dicts work — no import strictly required**. To add a system cache point you pass:

```python
system_prompt=[
    {"text": """<the system prompt>"""},
    {"cachePoint": {"type": "default"}},
]
```

Both paths converge on the same converse request `system=[{"text": ...}, {"cachePoint":{"type":"default"}}]`.

### 1c. Min-token behavior — SILENT NO-OP, not an error (LIVE PROBE)

`converse` on `global.anthropic.claude-sonnet-4-6`, us-west-2, `system=[{text}, {cachePoint:{type:default}}]`:

```
SHORT system prompt (~6 tokens) + cachePoint
    inputTokens=17 cacheWrite=0 cacheRead=0        <-- no error, cache simply skipped
[long system prompt ~11469 chars]
LONG system prompt + cachePoint (1st call = write)
    inputTokens=9 cacheWrite=1569 cacheRead=0      <-- cache written
LONG system prompt + cachePoint (2nd call = read)
    inputTokens=9 cacheWrite=0 cacheRead=1569      <-- cache hit
```

A cache point on a system prompt below the model minimum (~1024 tokens for Claude) is **silently ignored** — no `ValidationException`. So emitting a system cache point unconditionally is safe; short prompts just won't cache.

### 1d. Recommended generated-code shape for a "cache system prompt" toggle

Two viable options; recommend **option A (`cache_prompt`) for minimal, consistent diff**, with option B noted as the future-proof alternative if the team wants to avoid the deprecation warning.

**Current caching toggles already live in the three `generateModelConfig*` functions** next to `cacheMessages`/`cacheTools` (`code-generator.ts:1492/1496`, `1581/1585`, `graph-code-generator.ts` Bedrock branch). Adding `cache_prompt` there is a 1-line change per site and keeps `system_prompt=""" ... """` untouched at all ~10 emission sites:

**Option A (recommended — co-located with existing cache toggles, string prompt unchanged):**
```python
agent_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-4-6",
    temperature=0.7,
    max_tokens=32000,
    cache_prompt="default",          # <-- new; deprecated-but-functional in 1.47
    cache_config=CacheConfig(strategy="auto"),   # existing (cacheMessages)
    cache_tools="default"                          # existing (cacheTools)
)
```
Cost: prints one `UserWarning` per request build (stderr). No import change (`CacheConfig` already imported).

**Option B (future-proof — no deprecation, but touches every `Agent(...)` site):**
```python
agent = Agent(
    model=agent_model,
    system_prompt=[
        {"text": """You are a helpful AI assistant."""},
        {"cachePoint": {"type": "default"}},
    ],
    ...
)
```
Cost: changes the `system_prompt="""..."""` string form to a list at all ~10 emission sites (see §3 site list). No new import needed (plain dicts satisfy the `SystemContentBlock` TypedDict).

Docs ref: https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#system-prompt-caching

**System-prompt emission sites (relevant to Option B):** `code-generator.ts` lines 342, 396, 751, 771, 1132, 1156, 1252, 1276, 1408; `graph-code-generator.ts:440`. All use `system_prompt="""${escapePythonTripleQuotedString(...)}"""`.

---

## 2. Reasoning effort on Bedrock for Claude (THE key probe)

### 2a. Which `additionalModelRequestFields` shape is accepted (LIVE, us-west-2)

Probe over `global.anthropic.claude-sonnet-4-6` and `global.anthropic.claude-opus-4-8`, tiny prompt, `maxTokens=40`:

```
======== global.anthropic.claude-sonnet-4-6 ========
  ACCEPT  baseline (no ARF)
  ACCEPT  thinking adaptive (current)               {"thinking":{"type":"adaptive"}}
  REJECT  effort=low/medium/high/xhigh/max (top-level)   [ValidationException] effort: Extra inputs are not permitted
  REJECT  thinking.adaptive+effort=high              [ValidationException] thinking.adaptive.effort: Extra inputs are not permitted
  ACCEPT  output_config.effort=high                  {"output_config":{"effort":"high"}}   <-- WINNER
  REJECT  thinking enabled budget=1024               [ValidationException] max_tokens must be > thinking.budget_tokens
  REJECT  effort=high + thinking adaptive (both)      [ValidationException] effort: Extra inputs are not permitted
  REJECT  anthropic_beta effort + effort=high        [ValidationException] effort: Extra inputs are not permitted
  REJECT  reasoning_effort=high                       [ValidationException] reasoning_effort: Extra inputs are not permitted

======== global.anthropic.claude-opus-4-8 ========
  (same pattern; output_config.effort=high ACCEPT)
  REJECT  thinking enabled budget=1024
      [ValidationException] "thinking.type.enabled" is not supported for this model.
      Use "thinking.type.adaptive" and "output_config.effort..."   <-- Bedrock itself documents the canonical pattern
```

The Opus 4.8 error message is the smoking gun: the canonical pattern is **`thinking:{type:adaptive}` + `output_config:{effort:...}`**.

### 2b. Valid effort VALUES per model (LIVE) — MODEL-VERSION-DEPENDENT

```
=== output_config.effort value set ===
Sonnet 4.6 : low  medium  high  max        (xhigh REJECTED: "Input should be 'low','medium','high' or 'max'")
Sonnet 5   : low  medium  high  xhigh  max  (all accepted)
Opus 4.8   : low  medium  high  xhigh  max  (all accepted; rejects none/minimal with "unknown variant")
```

**CRITICAL FLAG for design:** the UI effort dropdown (`PropertyPanel.tsx:552-556`) already lists `low/medium/high/xhigh/max`. `xhigh` is invalid on **Sonnet 4.6 — which is `DEFAULT_MODEL_ID`**. A Sonnet-4.6 agent generated with `effort:"xhigh"` will `ValidationException` at runtime. The "no xhigh" is specific to the Claude 4.6 generation, not a Sonnet-vs-Opus split (Sonnet 5 accepts xhigh). Design must either gate `xhigh` out of the dropdown when the selected model is Sonnet 4.6, clamp `xhigh→high` in the generator for 4.6, or document the limitation. The common-safe set across the whole Claude catalog is **low/medium/high/max**.

### 2c. Effort is functional and combines with adaptive thinking (LIVE)

`{"thinking":{"type":"adaptive"}, "output_config":{"effort":v}}` accepted on both models. Behavioral run on Opus 4.8, reasoning prompt, `maxTokens=2500`:

```
adaptive+effort=low      out= 375  blocks=['reasoningContent','text']
adaptive+effort=medium   out= 427  blocks=['reasoningContent','text']
adaptive+effort=high     out= 409  blocks=['reasoningContent','text']
adaptive+effort=xhigh    out= 461  blocks=['reasoningContent','text']
adaptive+effort=max      out= 673  blocks=['reasoningContent','text']

effort WITHOUT thinking key:
effort=low   out=300  blocks=['text']    <-- no reasoning emitted
effort=high  out=258  blocks=['text']    <-- effort alone doesn't add reasoning depth
effort=max   out=265  blocks=['text']
```

Effort scales reasoning/output size (375→673 low→max) **only when `thinking:{type:adaptive}` is also present**. Effort alone is accepted but emits no reasoning blocks. Since the UI gates the effort control behind `thinkingEnabled` (`PropertyPanel.tsx:539`), the natural generated shape emits both.

### 2d. How strands 1.47 passes `additional_request_fields` (wheel source)

`bedrock.py` `_get_additional_request_fields` (lines 357-383): the dict is passed **verbatim** into `additionalModelRequestFields`, with ONE exception — when `tool_choice` forces a tool (`"any"`/`"tool"`, e.g. structured-output retries) it strips the `thinking` key:

```python
if is_forcing_tool and "thinking" in additional_fields:
    fields_without_thinking = {k: v for k, v in additional_fields.items() if k != "thinking"}
    ...
return {"additionalModelRequestFields": additional_fields}
```

Note: it strips `thinking` but **not** `output_config`. On a forced-tool call, `output_config.effort` would still be sent while `thinking` is dropped — harmless (effort without thinking is accepted, §2c). No other filtering.

### 2e. Recommended generated-code shape per tier (VERIFIED LIVE)

When `thinkingEnabled` on the Bedrock branch, emit both keys in the existing `additional_request_fields` dict (currently only `thinking` is emitted — `code-generator.ts:1482-1489`, `1571-1578`; `graph-code-generator.ts:101-107`):

```python
agent_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-4-6",
    temperature=1,              # already pinned to 1 when thinkingEnabled (finalTemperature)
    max_tokens=32000,
    additional_request_fields={
        "thinking": {
            "type": "adaptive"
        },
        "output_config": {
            "effort": "high"     # <- from data.reasoningEffort; one of low|medium|high|(xhigh)|max
        }
    }
)
```

Per-tier `additional_request_fields` (the `output_config.effort` value is literally the tier string): `low` → `{"output_config":{"effort":"low"}}`, ... `max` → `{"output_config":{"effort":"max"}}`. `xhigh` only on Sonnet 5 / Opus 4.8 (see 2b flag).

Current gap: `reasoningEffort` is destructured (`code-generator.ts:276`, etc.) and wired into the OpenAI (`reasoning_effort`) and Mantle (`reasoning:{effort}`) branches, but the **Bedrock branch ignores it today** — it only emits `thinking:{type:adaptive}`. Adding the `output_config` block is the change. The UI effort dropdown is likewise **hidden for Bedrock** today (`PropertyPanel.tsx:540` shows only an "adaptive thinking note" when `isBedrock`); exposing it for Bedrock is the paired UI change.

---

## 3. Streaming + max_tokens defaults

### 3a. Streaming — the codegen gate

Single fallback: **`code-generator.ts:852` `const isStreaming = executionAgentData.streaming || false;`** Then `else if (isStreaming)` at line 926 emits `stream_async`; otherwise sync. Findings:

- **Only the top-level execution agent streams.** `executionAgent` = `findConnectedAgent(...)` (the agent feeding the output node). Swarm branch (line 854) is always synchronous and ignores `streaming`. Sub-agents/orchestrator-as-tool are wrapped as tools and invoked synchronously — they have no streaming path. So "streaming = 主Agent only" already holds structurally; you do NOT need to touch orchestrator/swarm/sub-agent generation.
- **The streaming branch does NOT itself check for an output-node connection.** The output-node requirement is enforced globally: `generateCode` returns hard errors and emits nothing if no output node exists (lines 88-90) or none is connected (lines 102-109). So by the time line 852 runs, a connected output node is guaranteed graph-wide. The earlier "streaming only if data.streaming AND output connected" claim reflects the **UI** gate, not codegen (next bullet).
- **UI gate (separate):** `PropertyPanel.tsx:593` disables the streaming checkbox via `disabled={!hasConnectedOutputNode()}` — a node's streaming toggle is only editable when that node's `output` handle connects to an output node (`PropertyPanel.tsx:225-240`). Non-agent nodes always allow it.

**Locations to change for streaming default TRUE:**

| File:line | Current | Role |
|---|---|---|
| `code-generator.ts:852` | `executionAgentData.streaming \|\| false` | **THE codegen gate** — change fallback to `?? true` (or `!== false`) |
| `PropertyPanel.tsx:592` | `checked={data.streaming \|\| false}` | toggle display default — flip to `data.streaming ?? true` so UI matches codegen |
| `PropertyPanel.tsx:599-601` | hint uses `hasConnectedOutputNode()` | hint text; verify still coherent when default on |
| `FlowEditor.tsx:230-239` | agent drop default has NO `streaming` key | optionally add `streaming: true` so new nodes persist it explicitly |

**BACKWARD-COMPAT (critical):** the generator only ever reads `data.streaming` (never emits a model-level `streaming=` kwarg — grep confirms streaming appears in generated code paths ONLY at `code-generator.ts:852`/`928`). Changing the FALLBACK affects **only nodes where `streaming` is `undefined`**. Old saved graphs and all sample-flows that set `streaming: false` explicitly (`agent-with-mcp.ts:32`, `single-agent.ts:32`, `graph-dag.ts`, `orchestrator-sub-agents.ts`, `agent-swarm.ts`, `cached-research-pipeline.ts`) stay OFF. `skilled-pirate-assistant.ts:32` explicitly `true`. So the flip silently turns streaming on for undefined-streaming nodes only.

### 3b. max_tokens defaults — every location

| File:line | Current default | Context |
|---|---|---|
| `code-generator.ts:273` | `maxTokens = 4000` | agent config destructure |
| `code-generator.ts:308` | `maxTokens = 4000` | (orchestrator/swarm path destructure) |
| `code-generator.ts:361` | `maxTokens = 4000` | destructure |
| `code-generator.ts:1083` | `maxTokens = 4000` | tool/agent-as-tool path |
| `code-generator.ts:1183` | `maxTokens = 4000` | tool path |
| `code-generator.ts:1299` | `maxTokens = 4000` | orchestrator path |
| `code-generator.ts:1332` | `maxTokens = 4000` | swarm/orchestrator path |
| `graph-code-generator.ts:413` | `data.maxTokens \|\| 4000` | graph node model config |
| `FlowEditor.tsx:238` | `maxTokens: 4000` | agent node DROP default |
| `PropertyPanel.tsx:640` | `data.maxTokens \|\| 10000` | maxTokens input DISPLAY default (agent) |
| `PropertyPanel.tsx:703` | `data.maxTokens \|\| 10000` | maxTokens input DISPLAY default (2nd node type) |
| sample-flows (`*.ts:31/45/47/...`) | `maxTokens: 4000` | explicit per-node (saved graphs — won't change via fallback) |

Note the pre-existing inconsistency: generator/drop default is **4000**, PropertyPanel display default is **10000**. For a 32000 default, all fallbacks above (generator, graph, FlowEditor drop, both PropertyPanel displays) must change; sample-flows are explicit and independent.

### 3c. Is max_tokens=32000 valid for the catalog models? (LIVE PROBE)

`converse`, us-west-2, tiny prompt (maxTokens is a cap; output stays tiny):

```
global.anthropic.claude-sonnet-5     32000 ACCEPT   64000 ACCEPT   65536 ACCEPT
global.anthropic.claude-sonnet-4-6   32000 ACCEPT   64000 ACCEPT   65536 ACCEPT
global.anthropic.claude-opus-4-8     32000 ACCEPT   64000 ACCEPT   65536 ACCEPT
openai.gpt-oss-120b-1:0              32000 ACCEPT
qwen.qwen3-235b-a22b-2507-v1:0       32000 ACCEPT
qwen.qwen3-32b-v1:0                  32000 ACCEPT
deepseek.v3-v1:0                     32000 ACCEPT
us.amazon.nova-pro-v1:0              32000 REJECT  [ValidationException] exceeds the model limit of 10000
us.amazon.nova-premier-v1:0          64000 REJECT  [ValidationException] exceeds the model limit of 32000
                                     (32000 itself = at the cap; this account hit a Legacy ResourceNotFound on nova-premier)
```

**CRITICAL FLAG:** Nova Pro and Nova Premier are in `BEDROCK_MODELS` (`models.ts:78-84`), so they route through the native `BedrockModel` path and would receive `max_tokens=32000`. **Nova Pro (cap 10000) will `ValidationException`.** Nova Premier is exactly at its 32000 cap (no headroom). All Claude models + gpt-oss/qwen/deepseek accept 32000.

Recommendation for design (my read; final call is design's): a flat 32000 default is safe for Claude (the effort/thinking features are Claude-only anyway) but breaks Nova Pro. Options: (a) clamp max_tokens to a per-model cap in the generator (Nova Pro → ≤10000), (b) apply 32000 only when the provider/model is Claude and keep a lower default (e.g. 8000) for Nova, or (c) accept that Nova nodes need a manual lower value. The Mantle models (grok/gpt-5.x) go through `OpenAIResponsesModel.max_output_tokens`, not native converse — not covered by this probe.

---

## 4. aws-knowledge MCP — streamable-HTTP, no auth (LIVE)

```
POST https://knowledge-mcp.global.api.aws  (initialize, no auth headers)
-> {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26",
     "capabilities":{"tools":{"listChanged":false}},
     "serverInfo":{"name":"AWSKnowledgeMCP","version":"1.0.0"}}}
```

Confirmed: streamable-HTTP MCP, **no authentication required**, tools capability present.

**Sample MCP node data shape** (mirrors `agent-with-mcp.ts:41-43`; the generator reads `serverName`/`transportType`/`url` and emits `streamablehttp_client("${url}")` for `streamable_http`):

```ts
{
  serverName: 'aws_knowledge',          // becomes Python client var name; keep [a-z0-9_]
  transportType: 'streamable_http',     // matches code-generator.ts switch (line 423)
  url: 'https://knowledge-mcp.global.api.aws',
}
```

Generated client (per `code-generator.ts:439-441`): `aws_knowledge_client_XXXX = MCPClient(lambda: streamablehttp_client("https://knowledge-mcp.global.api.aws"))`. No headers/auth needed.

---

## Caveats / Not found

- **Effort behavioral numbers** (§2c out-token counts) are single-sample and non-deterministic; they demonstrate direction (effort scales reasoning depth) not exact magnitudes.
- **1.47 vs 1.9 runtime**: the local venv is strands 1.9.0. All 1.47 claims are from the downloaded 1.47.0 wheel *source*; I did not spin up a clean 1.47 venv to execute an end-to-end strands call. The Bedrock `converse` probes (effort shapes, tiers, max_tokens, caching) are provider-level and independent of the strands version. The `cache_prompt`-accepted-at-construction check ran on 1.9.0.
- **Nova Premier** returned a `ResourceNotFoundException` (Legacy / not-recently-used) at 32000 in this account, so its 32000-exact behavior wasn't directly confirmed; its 64000 rejection reports the cap as 32000.
- **Mantle models** (grok-4.3, gpt-5.5/5.4) not probed for max_output_tokens caps — they use the OpenAI Responses path, out of scope for the native-converse probes here.
- I did not probe `us`/`eu` regional variants individually; used the `global.` inference profiles. Tier/field acceptance is a model-family property, so regional variants should match.

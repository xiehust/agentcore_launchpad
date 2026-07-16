# Fix Claude SDK runtime invocation timeout

## Goal

Allow long-running Claude Agent SDK container invocations to use the full
Amazon Bedrock AgentCore synchronous request window instead of failing at the
botocore default read timeout.

## Background

- `app.services.agentcore.client.data_client()` currently creates the
  `bedrock-agentcore` client without a `botocore.config.Config`.
- Botocore therefore uses its 60-second default `read_timeout`.
- Claude SDK container entrypoints await the complete SDK query and return one
  buffered response, so a task that produces no response bytes within 60
  seconds raises `ReadTimeoutError` in the Launchpad backend.
- AgentCore Runtime permits synchronous requests to run for up to 15 minutes.

## Requirements

- Configure the shared `bedrock-agentcore` data client with a read timeout that
  exceeds the 15-minute AgentCore synchronous request limit.
- Default the timeout to 1000 seconds, leaving response-transfer margin beyond
  the 900-second service limit.
- Expose the timeout through normal Launchpad settings precedence so operators
  can override it with `launchpad.yaml` or
  `LAUNCHPAD_AGENTCORE_READ_TIMEOUT_S`.
- Do not change control-plane, Bedrock Agent, or Bedrock Agent Runtime client
  timeouts.
- Preserve the existing buffered invoke response contract and shared invoke
  chain.

## Acceptance Criteria

- [x] `data_client()` passes a `botocore.config.Config` whose `read_timeout`
      equals the configured `agentcore_read_timeout_s`.
- [x] The default timeout is 1000 seconds and an environment override is
      honored.
- [x] Regression tests cover the settings and client-factory behavior.
- [x] The canonical `make verify` gate passes.

## Out of Scope

- Converting Claude SDK containers to incremental response streaming.
- Extending AgentCore's 15-minute synchronous execution limit; longer work
  requires the service's asynchronous invocation model.
- Changing HTTP timeouts in external callers, proxies, or AWS infrastructure.

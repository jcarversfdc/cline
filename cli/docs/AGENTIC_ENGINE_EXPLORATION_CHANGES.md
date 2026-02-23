# Cline Project Changes (Agentic Engine Exploration)

This document records the changes made to the Cline project on branch `t/jcarver/cline-agentic-engine-exploration` to support embedding Cline as a headless agentic engine for the [agentic-dx](https://github.com/forcedotcom/agentic-dx) inner-vibes-service REST API. Keeping this in the Cline repo preserves context for future work or upstream discussion.

---

## Cline Project Changes

Three commits were added to the Cline fork on branch `t/jcarver/cline-agentic-engine-exploration`:

### 1. Salesforce LLM Gateway Integration (`salesforce.ts`)

**What:** A new `ApiHandler` provider (`src/core/api/providers/salesforce.ts`) that routes all LLM calls through the Salesforce LLM Gateway instead of directly to Anthropic, OpenAI, etc.

**Why:** The inner-vibes-service operates in a Salesforce context where LLM access is mediated by the Salesforce LLM Gateway. Cline's existing providers (Anthropic, OpenRouter, Bedrock, etc.) all authenticate directly with external LLM vendors. A custom provider was needed to:
- Authenticate using a Salesforce access token (exchanged for a short-lived JWT via the `/ide/auth` endpoint).
- Route requests to the appropriate Salesforce API environment (prod, dev, test, perf, stage).
- Translate between Cline's internal Anthropic message format and the gateway's expected payload format.
- Handle SSE streaming responses from the gateway, including tool-use blocks.

**Key details:**
- JWT caching with 50-minute TTL to avoid re-authentication on every LLM call.
- Gateway URL resolution based on `SF_API_ENV` environment variable.
- Model ID uses the `llmgateway__` prefix (e.g., `llmgateway__BedrockAnthropicClaude37Sonnet`) as required by the gateway.
- Retry logic with exponential backoff for transient failures.
- Files modified: `src/core/api/providers/salesforce.ts` (new), `src/core/api/index.ts`, `src/shared/api.ts`, `src/shared/storage/state-keys.ts`, `src/shared/storage/provider-keys.ts`.

### 2. Programmatic Service API (`service-api.ts`)

**What:** A new module (`cli/src/service-api.ts`) that exposes Cline's core agent as a programmatic JavaScript API, importable as `cline/service-api`.

**Why:** We needed to embed Cline's agent loop inside the inner-vibes-service Node.js process. Three approaches were considered:

| Approach | Description | Pros | Cons |
|---|---|---|---|
| **CLI subprocess** | Spawn `cline task "prompt"` as a child process | Simple; no code changes to Cline | Process management overhead; no streaming; `process.exit()` on completion; one process per task |
| **ACP over stdio** | Spawn `cline --acp` and communicate via JSON-RPC over stdin/stdout | Proper streaming; standard protocol | Subprocess lifecycle management; serialization cost on every message; debugging complexity across process boundaries |
| **In-process API** (chosen) | Import `cline/service-api` and call functions directly | Zero serialization overhead; direct EventEmitter streaming; single process; easy debugging | Tight coupling to Cline internals; singleton StateManager limits concurrency |

The in-process API was chosen because it eliminates the complexity of managing a child process, provides the lowest latency for message passing and event streaming, and makes debugging straightforward since everything runs in a single Node.js process.

**API surface:**
- `createClineEngine(options)` — Factory that initializes ClineAgent, configures the Salesforce provider, and enables auto-approve for headless operation. Returns a `ClineEngine` handle.
- `engine.createSession(cwd)` — Creates a new Cline task session for a given working directory. Returns a session ID.
- `engine.sendMessage(sessionId, text)` — Sends a user message to the session and runs the full agent loop (LLM call, tool execution, etc.). Resolves when the task completes.
- `engine.getEmitter(sessionId)` — Returns a typed EventEmitter for streaming events (`agent_message_chunk`, `tool_call`, `tool_call_update`, `end_turn`, `error`).
- `engine.getConversationHistory(sessionId)` — Returns the raw Anthropic-format conversation history from the underlying task.

**Key details:**
- The module reuses `ClineAgent` (the same class used by ACP mode) but bypasses the stdio transport layer.
- Salesforce credentials are written into Cline's `StateManager` global state so the `SalesforceHandler` picks them up automatically.
- Auto-approve is enabled globally for all tool calls (no interactive permission prompts in headless mode).
- Files modified: `cli/src/service-api.ts` (new), `cli/esbuild.mts` (added `service-api` entry point), `cli/package.json` (added `./service-api` export).

### 3. Model ID Fix

**What:** Changed the default model identifier from `sfdc_ai__DefaultBedrockAnthropicClaude3_5Sonnet` to `llmgateway__BedrockAnthropicClaude37Sonnet`.

**Why:** The Salesforce LLM Gateway expects model IDs with the `llmgateway__` prefix. The `sfdc_ai__` prefix returned a 404 error from the gateway.

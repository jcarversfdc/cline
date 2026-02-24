# Cline Project Changes (Agentic Engine Exploration)

This document records the changes made to the Cline project on branch `t/jcarver/cline-agentic-engine-exploration` to support embedding Cline as a headless agentic engine for the [agentic-dx](https://github.com/forcedotcom/agentic-dx) inner-vibes-service REST API. The integration uses **ACP over stdio**: agentic-dx spawns `cline --acp` as a subprocess per agent and communicates via the Agent Client Protocol. Keeping this in the Cline repo preserves context for future work or upstream discussion.

---

## Cline Project Changes

The following changes were required in the Cline fork. All changes require maintaining a fork or contributing upstream.

### 1. Salesforce LLM Gateway Provider (fork-required)

A new `ApiHandler` provider (`src/core/api/providers/salesforce.ts`) that routes all LLM calls through the Salesforce LLM Gateway.

**Why:** Cline has no plugin mechanism for custom LLM providers. The built-in providers (Anthropic, OpenRouter, Bedrock, etc.) authenticate directly with external LLM vendors. A custom provider was needed to:
- Authenticate using a Salesforce access token (exchanged for a short-lived JWT via `/ide/auth`)
- Route requests to the correct Salesforce API environment (prod, dev, test, perf, stage)
- Translate between Cline's internal Anthropic message format and the gateway's payload format
- Parse SSE streaming responses, including tool-use blocks

**Key details:**
- JWT caching with 50-minute TTL
- Gateway URL resolution based on `SF_API_ENV` environment variable
- Model ID uses the `llmgateway__` prefix (e.g. `llmgateway__BedrockAnthropicClaude37Sonnet`)
- Retry logic with exponential backoff for transient failures
- Files: `src/core/api/providers/salesforce.ts` (new), `src/core/api/index.ts`, `src/shared/api.ts`, `src/shared/storage/state-keys.ts`, `src/shared/storage/provider-keys.ts`

### 2. Salesforce Env-Var Auto-Configuration for ACP Mode (fork-required)

A shared utility (`cli/src/utils/salesforce-config.ts`) that configures the Salesforce provider from environment variables when `cline --acp` starts.

**Why:** ACP has no runtime credential-passing API, and the existing auth paths (`cline auth` CLI command, ACP `authenticate` with browser OAuth) aren't suitable for headless programmatic use. Credentials must be present in `StateManager` before the first session is created. We pass them as env vars when spawning the subprocess, and `ClineAgent.initialize()` reads them:
- `SF_ACCESS_TOKEN`, `SF_INSTANCE_URL` → configure provider
- `SF_API_ENV` → gateway environment
- `SF_MODEL_ID` → optional model override

The same utility enables global auto-approve for all tool calls (headless mode).

### 3. Custom `extMethod` for Conversation History (fork-required)

ACP does not include a built-in method for retrieving conversation history. We added a custom extension method in `AcpAgent`:

```typescript
// cli/src/acp/AcpAgent.ts
async extMethod(method: string, params: Record<string, unknown>) {
    if (method === "cline/getConversationHistory") {
        // Returns { history: Anthropic.MessageParam[] | null }
        return { history: session.controller.task.messageStateHandler.getApiConversationHistory() }
    }
    throw new Error(`Unknown extension method: ${method}`)
}
```

This enables `GET /messages` to return full conversation history without client-side accumulation.

### 4. Headless Mode / Host Layer Decoupling Fixes (fork-required)

Cline's core engine is tightly coupled to its interactive host layers (VS Code extension, CLI TUI). When running headless as an ACP subprocess, several assumptions break:

- **`Task.ask()` blocks on user input** — The task loop's `attempt_completion`, `ask_followup_question`, and other ask types wait indefinitely for a response from an interactive user that doesn't exist. We added a `headlessMode` flag to `StateManager` and CLI state overrides (`vscode-context.ts`) that auto-resolves these asks. Without this, the agent loop hangs after the LLM's first `attempt_completion`.
- **CLI state overrides** — The CLI/ACP path requires a `vscode-context.ts` module that stubs or overrides VS Code-specific behaviors (terminal execution mode, checkpoint settings, multi-root workspace, etc.). Any new host-layer assumption in Cline's core risks breaking the headless path.

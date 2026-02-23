/**
 * Programmatic entry point for embedding Cline as a headless service.
 *
 * This module provides a `createClineEngine()` factory that handles all
 * Cline initialization and returns a simple API surface suitable for use
 * by the agentic-dx inner-vibes-service (and similar embedders) without
 * any VS Code or stdio dependencies.
 *
 * Design decisions and pain points are documented inline.
 *
 * @module service-api
 */

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { StateManager } from "@/core/storage/StateManager"
import { ClineAgent } from "./agent/ClineAgent.js"
import { ClineSessionEmitter } from "./agent/ClineSessionEmitter.js"
import type { ClineAcpSession } from "./agent/types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Salesforce org credentials needed to authenticate against the LLM gateway.
 * These are passed per-engine-instance so each VaaS agent can carry its own
 * user's credentials.
 */
export interface SalesforceCredentials {
	/** Salesforce org access token (from OAuth) */
	accessToken: string
	/** Salesforce org instance URL (e.g. https://myorg.my.salesforce.com) */
	instanceUrl: string
	/** LLM model ID to use (optional, defaults to Anthropic Claude 3.5 Sonnet via gateway) */
	modelId?: string
	/** Gateway environment: prod | dev | test | perf | stage (default: prod) */
	apiEnv?: string
}

/**
 * Options for creating a ClineEngine instance.
 */
export interface ClineEngineOptions {
	/**
	 * Salesforce credentials for the LLM gateway.
	 */
	credentials: SalesforceCredentials

	/**
	 * Version string reported by the agent in the ACP handshake.
	 * Defaults to "1.0.0".
	 */
	version?: string
}

/**
 * A handle to an active Cline agent, exposing the operations needed by the
 * agentic-dx ChatSession interface.
 */
export interface ClineEngine {
	/**
	 * Create a new chat session (Cline "task") for the given working directory.
	 * Returns the session ID that must be passed to subsequent calls.
	 *
	 * PAIN POINT (REQ 6): There is no way to restore a prior session — only new
	 * sessions can be created via the ACP API. `loadSession` capability exists
	 * but only resumes from Cline's internal task history, not from an external
	 * caller-provided state.
	 */
	createSession(cwd: string): Promise<string>

	/**
	 * Send a user message to the given session.
	 * Resolves after the agent completes its task loop (end_turn received).
	 *
	 * PAIN POINT: `ClineAgent.prompt()` resolves only when the internal task
	 * loop emits a completion signal. There is no "streaming" resolution — callers
	 * must subscribe to the emitter BEFORE calling sendMessage() to observe
	 * incremental events.
	 */
	sendMessage(sessionId: string, text: string): Promise<void>

	/**
	 * Get the typed event emitter for a session.
	 * Subscribe before calling sendMessage() to receive streaming events.
	 *
	 * Key events:
	 *   - agent_message_chunk: incremental text from the assistant
	 *   - agent_thought_chunk: reasoning/thinking tokens
	 *   - tool_call: a tool is being invoked (file write, shell command, etc.)
	 *   - tool_call_update: incremental tool output (e.g. command stdout)
	 *   - end_turn: task completed; includes stop reason
	 *   - error: session-level error
	 */
	getEmitter(sessionId: string): ClineSessionEmitter

	/**
	 * Get the raw API conversation history for a session as Anthropic-format
	 * messages. Returns null if the session or its task cannot be found.
	 *
	 * This is the underlying LLM message history (not the Cline UI message list).
	 */
	getConversationHistory(sessionId: string): Promise<{ role: string; content: unknown }[] | null>

	/**
	 * List all active session IDs held by this engine instance.
	 */
	listSessionIds(): string[]

	/**
	 * Shut down the engine: cancels in-flight prompts and cleans up resources.
	 */
	shutdown(): Promise<void>

	/**
	 * Expose the underlying ClineAgent for callers that need direct ACP access.
	 * Treat this as an escape hatch — the surface may change with upstream Cline.
	 */
	readonly agent: ClineAgent
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and initialize a ClineEngine instance.
 *
 * Initialization sequence:
 * 1. Instantiate ClineAgent (calls initializeCliContext() internally)
 * 2. Call agent.initialize() — this initializes HostProvider, StateManager,
 *    and ClineEndpoint in the correct order.
 * 3. Configure the Salesforce provider in StateManager.
 * 4. Enable auto-approve for headless operation.
 *
 * PAIN POINT (initialization order): Cline's initialization is implicit and
 * order-sensitive. StateManager, HostProvider, and ClineEndpoint must all be
 * set up before any Controller or Task is created. The only safe way to trigger
 * this sequence from outside is via agent.initialize(). Attempting to call
 * StateManager.initialize() or HostProvider.initialize() directly risks double-
 * initialization errors because agent.initialize() calls them too.
 *
 * PAIN POINT (singleton state, REQ 11): StateManager and HostProvider are
 * process-level singletons. Only ONE ClineEngine instance can safely exist per
 * process. Creating a second engine will re-use the first engine's StateManager,
 * meaning provider configuration and settings are shared. For VaaS multi-tenant
 * use, each agent would need its own Node.js process.
 */
export async function createClineEngine(options: ClineEngineOptions): Promise<ClineEngine> {
	const version = options.version ?? "1.0.0"

	// Step 1: Create the agent. The constructor calls initializeCliContext()
	// which sets up file-backed storage in ~/.cline (or $CLINE_DIR).
	const agent = new ClineAgent({ version })

	// Step 2: Initialize via the ACP handshake path. This calls (in order):
	//   - initializeHostProvider() → HostProvider.initialize()
	//   - ClineEndpoint.initialize()
	//   - StateManager.initialize()
	// We pass minimal clientCapabilities since we are not an interactive client.
	await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

	// Step 3: Configure the Salesforce LLM provider in StateManager.
	// Must happen AFTER agent.initialize() because StateManager is set up there.
	await configureSalesforceProvider(options.credentials)

	// Step 4: Enable auto-approve for all tool calls.
	// Without this, Cline will halt each task and wait for permission via the
	// PermissionHandler callback. In a headless service there is no interactive
	// user to approve, so we enable global auto-approve.
	//
	// PAIN POINT (REQ 9 / security): This is global — there is no per-session
	// or per-tool-type approval policy. Any code that Cline decides to run will
	// execute without any check. Production deployments should implement a
	// PermissionHandler that filters by tool type and path.
	const stateManager = StateManager.get()
	stateManager.setGlobalState("autoApproveAllToggled", true)
	await stateManager.flushPendingState()

	return new ClineEngineImpl(agent)
}

// ---------------------------------------------------------------------------
// Salesforce provider configuration
// ---------------------------------------------------------------------------

/**
 * Write Salesforce credentials into the StateManager global state so that
 * buildApiHandler() will pick them up when constructing a SalesforceHandler.
 *
 * These keys correspond to the fields added to API_HANDLER_SETTINGS_FIELDS in
 * src/shared/storage/state-keys.ts during Phase 1.
 *
 * PAIN POINT: StateManager stores settings as untyped key-value pairs. There
 * is no compile-time guarantee that the key names used here match the keys
 * read by SalesforceHandler. A typo in either location is a silent runtime
 * failure.
 */
async function configureSalesforceProvider(credentials: SalesforceCredentials): Promise<void> {
	const stateManager = StateManager.get()

	// Set provider for both plan and act modes
	stateManager.setGlobalState("actModeApiProvider", "salesforce")
	stateManager.setGlobalState("planModeApiProvider", "salesforce")

	// Store Salesforce-specific credentials in settings so SalesforceHandler
	// can read them via ApiConfiguration options. Cast through `any` because
	// the generated types may not yet be in sync if a full build hasn't run.
	stateManager.setGlobalState(
		"salesforceAccessToken" as Parameters<typeof stateManager.setGlobalState>[0],
		credentials.accessToken,
	)
	stateManager.setGlobalState(
		"salesforceInstanceUrl" as Parameters<typeof stateManager.setGlobalState>[0],
		credentials.instanceUrl,
	)
	if (credentials.modelId) {
		stateManager.setGlobalState("salesforceModelId" as Parameters<typeof stateManager.setGlobalState>[0], credentials.modelId)
	}
	if (credentials.apiEnv) {
		stateManager.setGlobalState("salesforceApiEnv" as Parameters<typeof stateManager.setGlobalState>[0], credentials.apiEnv)
	}

	// Also store the access token as the "salesforceApiKey" secret so that
	// ClineAgent.isAuthConfigured() passes. The auth check reads from the
	// secrets store (not settings) via ProviderToApiKeyMap. Salesforce uses
	// a short-lived access token rather than a static API key, so we reuse it
	// here as the auth sentinel. The SalesforceHandler itself reads the token
	// from API_HANDLER_SETTINGS_FIELDS (settings), not from secrets.
	stateManager.setSecret("salesforceApiKey", credentials.accessToken)

	// Set the generic model ID so Cline's telemetry/display has a value.
	const displayModel = credentials.modelId ?? "llmgateway__BedrockAnthropicClaude37Sonnet"
	stateManager.setGlobalState("actModeApiModelId" as Parameters<typeof stateManager.setGlobalState>[0], displayModel)
	stateManager.setGlobalState("planModeApiModelId" as Parameters<typeof stateManager.setGlobalState>[0], displayModel)

	await stateManager.flushPendingState()
}

// ---------------------------------------------------------------------------
// ClineEngine implementation
// ---------------------------------------------------------------------------

class ClineEngineImpl implements ClineEngine {
	readonly agent: ClineAgent

	constructor(agent: ClineAgent) {
		this.agent = agent
	}

	async createSession(cwd: string): Promise<string> {
		// newSession() will call isAuthConfigured() → checks StateManager for a
		// key matching the current provider. The "salesforce" provider was not
		// listed in ProviderToApiKeyMap (src/shared/storage/provider-keys.ts),
		// so isAuthConfigured() returns false and throws authRequired().
		//
		// PAIN POINT: The auth check is hardcoded for known providers and cannot
		// be extended without modifying provider-keys.ts. We work around this by
		// adding a sentinel entry for "salesforce" in the API key map, or by
		// storing a non-null value for whichever key the check falls through to.
		//
		// For now, the isAuthConfigured() check falls through to ProviderToApiKeyMap
		// lookup → undefined for "salesforce" → returns false. We must add
		// "salesforce" to ProviderToApiKeyMap so the check passes.
		const response = await this.agent.newSession({ cwd, mcpServers: [] })
		return response.sessionId
	}

	async sendMessage(sessionId: string, text: string): Promise<void> {
		await this.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text }],
		})
	}

	getEmitter(sessionId: string): ClineSessionEmitter {
		return this.agent.emitterForSession(sessionId)
	}

	async getConversationHistory(sessionId: string): Promise<{ role: string; content: unknown }[] | null> {
		const session: ClineAcpSession | undefined = this.agent.sessions.get(sessionId)
		if (!session?.controller?.task) {
			return null
		}
		try {
			return session.controller.task.messageStateHandler.getApiConversationHistory() as {
				role: string
				content: unknown
			}[]
		} catch {
			return null
		}
	}

	listSessionIds(): string[] {
		return Array.from(this.agent.sessions.keys())
	}

	async shutdown(): Promise<void> {
		await this.agent.shutdown()
	}
}

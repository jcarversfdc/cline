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
import type { SalesforceCredentials } from "./utils/salesforce-config.js"
import { configureSalesforceProvider, enableAutoApprove } from "./utils/salesforce-config.js"
export type { SalesforceCredentials }

import { ClineAgent } from "./agent/ClineAgent.js"
import { ClineSessionEmitter } from "./agent/ClineSessionEmitter.js"
import type { ClineAcpSession } from "./agent/types.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
	process.stdout.write("[Cline] Creating ClineEngine, initializing agent and Salesforce provider\n")

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

	// Step 4: Enable auto-approve for all tool calls (headless mode).
	await enableAutoApprove()

	return new ClineEngineImpl(agent)
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
		process.stdout.write(`[Cline] Creating session, cwd=${cwd}\n`)
		const response = await this.agent.newSession({ cwd, mcpServers: [] })
		return response.sessionId
	}

	async sendMessage(sessionId: string, text: string): Promise<void> {
		process.stdout.write(`[Cline] Sending message to session ${sessionId}\n`)
		await this.agent.prompt({
			sessionId,
			prompt: [{ type: "text", text }],
		})
	}

	getEmitter(sessionId: string): ClineSessionEmitter {
		process.stdout.write(`[Cline] Subscribing to session events for session ${sessionId}\n`)
		return this.agent.emitterForSession(sessionId)
	}

	async getConversationHistory(sessionId: string): Promise<{ role: string; content: unknown }[] | null> {
		process.stdout.write(`[Cline] Retrieving conversation history for session ${sessionId}\n`)
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

import { randomBytes } from "node:crypto"
import { ClineStorageMessage } from "@/shared/messages/content"
import { ClineTool } from "@/shared/tools"
import { ApiHandler, CommonApiHandlerOptions } from "../index"
import { withRetry } from "../retry"
import { ApiStream, ApiStreamToolCallsChunk } from "../transform/stream"

/**
 * Options for the Salesforce LLM Gateway handler.
 *
 * Authentication and endpoint configuration are read from environment variables:
 *   SF_ACCESS_TOKEN       – Salesforce access token (used to obtain a JWT via /ide/auth)
 *   SF_INSTANCE_URL       – Salesforce instance URL (e.g. https://myorg.my.salesforce.com)
 *   SF_API_ENV            – Gateway environment: prod | dev | test | perf | stage (default: prod)
 *   SF_LLM_MODEL          – Model identifier sent to the gateway (default: sfdc_ai__DefaultBedrockAnthropicClaude3_5Sonnet)
 *
 * These are intentionally environment-driven so that the handler works in headless / service
 * mode without needing UI-based configuration. In Phase 2 the programmatic entry point will
 * set these before constructing the handler.
 */
export interface SalesforceHandlerOptions extends CommonApiHandlerOptions {
	salesforceAccessToken?: string
	salesforceInstanceUrl?: string
	salesforceModelId?: string
	salesforceApiEnv?: string
}

// ---------------------------------------------------------------------------
// JWT cache
// ---------------------------------------------------------------------------

interface JwtCacheEntry {
	jwt: string
	tenantId: string
	expiresAt: number
}

const JWT_CACHE_TTL_MS = 50 * 60 * 1000

// ---------------------------------------------------------------------------
// Gateway URL helpers
// ---------------------------------------------------------------------------

type SfApiEnv = "prod" | "dev" | "test" | "perf" | "stage"

function resolveSfApiEnv(envStr?: string): SfApiEnv {
	const raw = (envStr ?? process.env["SF_API_ENV"] ?? "prod").toLowerCase()
	const allowed: SfApiEnv[] = ["prod", "dev", "test", "perf", "stage"]
	return allowed.includes(raw as SfApiEnv) ? (raw as SfApiEnv) : "prod"
}

function getSalesforceBaseUrl(env: SfApiEnv): string {
	switch (env) {
		case "dev":
			return "https://dev.api.salesforce.com"
		case "test":
			return "https://test.api.salesforce.com"
		case "perf":
			return "https://perf.api.salesforce.com"
		case "stage":
			return "https://stage.api.salesforce.com"
		case "prod":
		default:
			return "https://api.salesforce.com"
	}
}

function getSalesforceRegionHeader(env: SfApiEnv): string {
	switch (env) {
		case "prod":
			return "EAST_REGION_1"
		case "stage":
			return "EAST_REGION_2"
		default:
			return "WEST_REGION"
	}
}

function getGatewayBaseUrl(env: SfApiEnv): string {
	return `${getSalesforceBaseUrl(env)}/einstein/gpt/code/v1.1`
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function decodeJwtTenantId(jwt: string): string {
	const parts = jwt.split(".")
	if (parts.length < 2) {
		throw new Error("Salesforce LLM Gateway: invalid JWT format")
	}
	const headerJson = Buffer.from(parts[0], "base64url").toString("utf-8")
	const header = JSON.parse(headerJson) as { tnk?: string }
	if (typeof header.tnk !== "string") {
		throw new Error("Salesforce LLM Gateway: JWT header missing tnk (tenant id)")
	}
	return header.tnk
}

// ---------------------------------------------------------------------------
// Message format conversion (Cline/Anthropic → Salesforce gateway)
// ---------------------------------------------------------------------------

interface SalesforceChatMessage {
	role: "system" | "user" | "assistant" | "tool"
	content: string
	tool_call_id?: string
	tool_call_name?: string
	tool_invocations?: Array<{ id: string; function: { name: string; arguments: string } }>
}

/**
 * Convert Cline's internal messages (Anthropic format) into the Salesforce
 * gateway ChatMessageRequest format.
 *
 * Cline stores messages as ClineStorageMessage[] with role "user" | "assistant"
 * and structured content blocks (text, tool_use, tool_result, image, thinking).
 * The gateway expects simple {role, content} messages with tool_invocations
 * on assistant messages and role:"tool" for tool results.
 */
function convertToSalesforceMessages(messages: ClineStorageMessage[]): SalesforceChatMessage[] {
	const out: SalesforceChatMessage[] = []

	for (const msg of messages) {
		if (typeof msg.content === "string") {
			out.push({ role: msg.role, content: msg.content })
			continue
		}

		if (msg.role === "user") {
			const toolResults: SalesforceChatMessage[] = []
			const textParts: string[] = []

			for (const block of msg.content) {
				if (block.type === "tool_result") {
					let content: string
					if (typeof block.content === "string") {
						content = block.content
					} else if (Array.isArray(block.content)) {
						content = block.content
							.map((p: any) => (p.type === "text" ? p.text : ""))
							.filter(Boolean)
							.join("\n")
					} else {
						content = ""
					}
					toolResults.push({
						role: "tool",
						content,
						tool_call_id: block.tool_use_id,
					})
				} else if (block.type === "text" && block.text) {
					textParts.push(block.text)
				}
				// Images are not supported by the gateway text protocol; skip.
			}

			// Tool result messages go first (they match preceding assistant tool_invocations)
			out.push(...toolResults)

			if (textParts.length > 0) {
				out.push({ role: "user", content: textParts.join("\n") })
			}
		} else if (msg.role === "assistant") {
			let text = ""
			const toolInvocations: Array<{ id: string; function: { name: string; arguments: string } }> = []

			for (const block of msg.content) {
				if (block.type === "text" && block.text) {
					text += block.text
				} else if (block.type === "tool_use") {
					toolInvocations.push({
						id: block.id,
						function: {
							name: block.name,
							arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
						},
					})
				}
				// Thinking/reasoning blocks are not sent back to the gateway.
			}

			if (toolInvocations.length > 0) {
				out.push({ role: "assistant", content: text, tool_invocations: toolInvocations })
			} else {
				out.push({ role: "assistant", content: text })
			}
		}
	}

	return out
}

// ---------------------------------------------------------------------------
// Tool format conversion (Cline ClineTool → Salesforce gateway tool)
// ---------------------------------------------------------------------------

interface SalesforceGatewayTool {
	function: {
		name: string
		description?: string
		parameters?: Record<string, unknown>
	}
}

/**
 * Cline passes tools as ClineTool which is a union of OpenAI, Anthropic, and
 * Google tool types. The Salesforce gateway expects OpenAI-style function tools.
 * We normalise them here.
 */
function convertClineToolsToGateway(tools: ClineTool[]): SalesforceGatewayTool[] {
	return tools.map((tool: any) => {
		// OpenAI format: { type: "function", function: { name, description, parameters } }
		if (tool.type === "function" && tool.function) {
			return {
				function: {
					name: tool.function.name,
					...(tool.function.description != null && { description: tool.function.description }),
					...(tool.function.parameters != null && { parameters: tool.function.parameters }),
				},
			}
		}
		// Anthropic format: { name, description, input_schema }
		if (tool.name) {
			return {
				function: {
					name: tool.name,
					...(tool.description != null && { description: tool.description }),
					...(tool.input_schema != null && { parameters: tool.input_schema }),
				},
			}
		}
		// Google format (FunctionDeclaration): { name, description, parameters }
		return {
			function: {
				name: tool.name ?? "unknown",
				...(tool.description != null && { description: tool.description }),
				...(tool.parameters != null && { parameters: tool.parameters }),
			},
		}
	})
}

// ---------------------------------------------------------------------------
// Gateway response types (streaming SSE)
// ---------------------------------------------------------------------------

interface SalesforceStreamChunk {
	id?: string
	generation_details?: {
		generations?: Array<{
			content?: string
			role?: string
			parameters?: { finish_reason?: string }
			tool_invocations?: Array<{
				id: string
				function: { name: string; arguments: string }
			}>
		}>
		parameters?: {
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
		}
	}
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

// ---------------------------------------------------------------------------
// SalesforceHandler
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "llmgateway__BedrockAnthropicClaude37Sonnet"

export class SalesforceHandler implements ApiHandler {
	private options: SalesforceHandlerOptions
	private jwtCache: JwtCacheEntry | null = null
	private abortController: AbortController | null = null

	constructor(options: SalesforceHandlerOptions) {
		this.options = options
	}

	// -----------------------------------------------------------------------
	// Auth
	// -----------------------------------------------------------------------

	private getAccessToken(): string {
		const token = this.options.salesforceAccessToken ?? process.env["SF_ACCESS_TOKEN"]
		if (!token) {
			throw new Error(
				"Salesforce LLM Gateway: SF_ACCESS_TOKEN environment variable or salesforceAccessToken option is required",
			)
		}
		return token
	}

	private getInstanceUrl(): string {
		const url = this.options.salesforceInstanceUrl ?? process.env["SF_INSTANCE_URL"]
		if (!url) {
			throw new Error(
				"Salesforce LLM Gateway: SF_INSTANCE_URL environment variable or salesforceInstanceUrl option is required",
			)
		}
		return url
	}

	private getModelId(): string {
		return this.options.salesforceModelId ?? process.env["SF_LLM_MODEL"] ?? DEFAULT_MODEL
	}

	/**
	 * Obtain a JWT from the Salesforce org via the /ide/auth endpoint.
	 * The JWT is cached for 50 minutes.
	 */
	private async getJwt(): Promise<{ jwt: string; tenantId: string }> {
		if (this.jwtCache && this.jwtCache.expiresAt > Date.now()) {
			return { jwt: this.jwtCache.jwt, tenantId: this.jwtCache.tenantId }
		}

		const instanceUrl = this.getInstanceUrl()
		const accessToken = this.getAccessToken()
		const url = `${instanceUrl}/ide/auth`

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: "{}",
		})

		if (!response.ok) {
			const body = await response.text()
			throw new Error(`Salesforce LLM Gateway: /ide/auth failed (${response.status}): ${body}`)
		}

		const data = (await response.json()) as { jwt?: string }
		if (!data?.jwt) {
			throw new Error("Salesforce LLM Gateway: /ide/auth response missing jwt field")
		}

		const tenantId = decodeJwtTenantId(data.jwt)
		this.jwtCache = { jwt: data.jwt, tenantId, expiresAt: Date.now() + JWT_CACHE_TTL_MS }
		return { jwt: data.jwt, tenantId }
	}

	/**
	 * Build the gateway request headers required for every LLM call.
	 */
	private buildRequestHeaders(jwt: string, tenantId: string): Record<string, string> {
		const env = resolveSfApiEnv(this.options.salesforceApiEnv)
		return {
			Authorization: `Bearer ${jwt}`,
			"Content-Type": "application/json;charset=utf-8",
			"x-client-feature-id": "EinsteinGptForDevelopers",
			"x-sfdc-app-context": "EinsteinGPT",
			"x-sfdc-core-tenant-id": tenantId,
			"x-salesforce-region": getSalesforceRegionHeader(env),
			"x-client-trace-id": randomBytes(8).toString("hex"),
		}
	}

	// -----------------------------------------------------------------------
	// ApiHandler interface
	// -----------------------------------------------------------------------

	@withRetry()
	async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: ClineTool[]): ApiStream {
		const { jwt, tenantId } = await this.getJwt()
		const headers = this.buildRequestHeaders(jwt, tenantId)
		const modelId = this.getModelId()
		const env = resolveSfApiEnv(this.options.salesforceApiEnv)
		const baseUrl = getGatewayBaseUrl(env)

		// Build gateway messages: system prompt + conversation
		const gatewayMessages: SalesforceChatMessage[] = [
			{ role: "system", content: systemPrompt },
			...convertToSalesforceMessages(messages),
		]

		// Build request body
		const body: Record<string, unknown> = {
			messages: gatewayMessages,
			model: modelId,
			system_prompt_strategy: "use_model_parameter",
			generation_settings: {
				max_tokens: 8192,
				temperature: 0,
			},
		}

		// Add tools if provided
		if (tools && tools.length > 0) {
			body.tools = convertClineToolsToGateway(tools)
			body.tool_config = { mode: "auto", parallel_calls: true }
		}

		// Make streaming request
		this.abortController = new AbortController()
		const url = `${baseUrl}/chat/generations/stream`
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: this.abortController.signal,
		})

		if (!response.ok) {
			const errorBody = await response.text()
			throw new Error(`Salesforce LLM Gateway error (${response.status}): ${errorBody}`)
		}

		if (!response.body) {
			throw new Error("Salesforce LLM Gateway: no response body")
		}

		// Parse the SSE stream and yield ApiStreamChunks
		yield* this.parseSSEStream(response.body)
	}

	getModel() {
		const modelId = this.getModelId()
		return {
			id: modelId,
			info: {
				maxTokens: 8192,
				contextWindow: 200_000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 3.0,
				outputPrice: 15.0,
				description: `Salesforce LLM Gateway model: ${modelId}`,
			},
		}
	}

	abort(): void {
		this.abortController?.abort()
		this.abortController = null
	}

	// -----------------------------------------------------------------------
	// SSE stream parser
	// -----------------------------------------------------------------------

	/**
	 * Parse the Salesforce gateway SSE stream into Cline ApiStreamChunks.
	 *
	 * The gateway sends SSE events with `data: {json}` lines, terminated
	 * by `data: [DONE]`. Tool invocation arguments arrive in partial chunks
	 * and must be buffered until the stream ends.
	 */
	private async *parseSSEStream(body: ReadableStream<Uint8Array>): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""

		// Buffer for tool invocations whose arguments arrive incrementally
		const bufferedInvocations = new Map<string, { id: string; name: string; argsBuffer: string }>()
		let currentInvocationId: string | null = null
		let seenDone = false

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() ?? ""

				for (const line of lines) {
					if (!line.startsWith("data: ")) continue

					const data = line.slice(6).trim()
					if (data === "[DONE]" || data === "DONE") {
						seenDone = true
						break
					}

					let parsed: SalesforceStreamChunk
					try {
						parsed = JSON.parse(data) as SalesforceStreamChunk
					} catch {
						continue
					}

					const generations = parsed.generation_details?.generations ?? []
					const first = generations[0]

					// Text content
					if (first?.content) {
						yield { type: "text" as const, text: first.content }
					}

					// Tool invocations (buffered – gateway sends arguments incrementally)
					const toolInvocations = first?.tool_invocations ?? []
					for (const ti of toolInvocations) {
						const id: string | null = ti.id ?? currentInvocationId
						const name = ti.function?.name ?? ""
						const argsChunk = ti.function?.arguments ?? ""

						if (id) {
							if (!bufferedInvocations.has(id)) {
								bufferedInvocations.set(id, { id, name, argsBuffer: argsChunk })
								currentInvocationId = id
							} else {
								const buf = bufferedInvocations.get(id)!
								buf.argsBuffer += argsChunk
								if (name) buf.name = name
							}
						} else if (currentInvocationId) {
							bufferedInvocations.get(currentInvocationId)!.argsBuffer += argsChunk
						}
					}

					// Usage
					const usage = parsed.generation_details?.parameters?.usage ?? parsed.usage
					if (usage) {
						yield {
							type: "usage" as const,
							inputTokens: usage.prompt_tokens ?? 0,
							outputTokens: usage.completion_tokens ?? 0,
						}
					}
				}

				if (seenDone) break
			}
		} finally {
			reader.releaseLock()
		}

		// Emit buffered tool calls as complete tool_calls chunks.
		// Cline expects one tool_calls chunk per tool invocation, with fully assembled arguments.
		for (const inv of bufferedInvocations.values()) {
			let parsedArgs: Record<string, unknown>
			try {
				parsedArgs = JSON.parse(inv.argsBuffer.trim() || "{}")
			} catch {
				parsedArgs = {}
			}

			const chunk: ApiStreamToolCallsChunk = {
				type: "tool_calls",
				tool_call: {
					call_id: inv.id,
					function: {
						id: inv.id,
						name: inv.name,
						arguments: parsedArgs,
					},
				},
			}
			yield chunk
		}
	}
}

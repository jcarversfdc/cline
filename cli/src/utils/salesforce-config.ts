/**
 * Shared Salesforce LLM Gateway configuration for Cline.
 *
 * Used by ACP mode (cline --acp) when credentials are supplied via environment
 * variables. ClineAgent.initialize() calls getSalesforceCredentialsFromEnv() and,
 * if present, configureSalesforceProvider() and enableAutoApprove().
 *
 * PAIN POINT: The Salesforce gateway customization (src/core/api/providers/salesforce.ts)
 * is a single implementation used for all LLM calls when the provider is "salesforce".
 * Cline only uses it when StateManager has actModeApiProvider/planModeApiProvider and
 * credentials set. We do not re-implement the gateway; we only configure StateManager
 * from env vars when running as a subprocess.
 *
 * @module utils/salesforce-config
 */

import { StateManager } from "@/core/storage/StateManager"

/**
 * Salesforce org credentials for the LLM gateway.
 * Read from env in ACP mode via getSalesforceCredentialsFromEnv().
 */
export interface SalesforceCredentials {
	/** Salesforce org access token (from OAuth) */
	accessToken: string
	/** Salesforce org instance URL (e.g. https://myorg.my.salesforce.com) */
	instanceUrl: string
	/** LLM model ID to use (optional, defaults to Anthropic Claude via gateway) */
	modelId?: string
	/** Gateway environment: prod | dev | test | perf | stage (default: prod) */
	apiEnv?: string
}

/**
 * Write Salesforce credentials into StateManager so buildApiHandler() will
 * construct a SalesforceHandler. Keys must match API_HANDLER_SETTINGS_FIELDS
 * and the secrets map used by isAuthConfigured().
 *
 * Must be called after StateManager.initialize().
 */
export async function configureSalesforceProvider(credentials: SalesforceCredentials): Promise<void> {
	const stateManager = StateManager.get()

	stateManager.setGlobalState("actModeApiProvider", "salesforce")
	stateManager.setGlobalState("planModeApiProvider", "salesforce")

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

	stateManager.setSecret("salesforceApiKey", credentials.accessToken)

	const displayModel = credentials.modelId ?? "llmgateway__BedrockAnthropicClaude37Sonnet"
	stateManager.setGlobalState("actModeApiModelId" as Parameters<typeof stateManager.setGlobalState>[0], displayModel)
	stateManager.setGlobalState("planModeApiModelId" as Parameters<typeof stateManager.setGlobalState>[0], displayModel)

	await stateManager.flushPendingState()
}

/**
 * Enable global auto-approve for all tool calls (headless mode).
 * Must be called after StateManager.initialize().
 */
export async function enableAutoApprove(): Promise<void> {
	const stateManager = StateManager.get()
	stateManager.setGlobalState("autoApproveAllToggled", true)
	await stateManager.flushPendingState()
}

const ENV_ACCESS_TOKEN = "SF_ACCESS_TOKEN"
const ENV_INSTANCE_URL = "SF_INSTANCE_URL"
const ENV_API_ENV = "SF_API_ENV"
const ENV_MODEL_ID = "SF_MODEL_ID"

/**
 * Build Salesforce credentials from environment variables.
 * Returns null if SF_ACCESS_TOKEN or SF_INSTANCE_URL are missing.
 */
export function getSalesforceCredentialsFromEnv(): SalesforceCredentials | null {
	const accessToken = process.env[ENV_ACCESS_TOKEN]
	const instanceUrl = process.env[ENV_INSTANCE_URL]
	if (!accessToken || !instanceUrl) {
		return null
	}
	const apiEnv = process.env[ENV_API_ENV]
	const modelId = process.env[ENV_MODEL_ID]
	return {
		accessToken,
		instanceUrl,
		...(apiEnv && { apiEnv: apiEnv.toLowerCase() }),
		...(modelId && { modelId }),
	}
}

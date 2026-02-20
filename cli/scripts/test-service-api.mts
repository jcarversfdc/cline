/**
 * Manual integration test for the ClineEngine service API.
 *
 * Usage:
 *   SF_ACCESS_TOKEN=<token> SF_INSTANCE_URL=<url> npx tsx scripts/test-service-api.mts
 *
 * This script exercises the programmatic API surface that agentic-dx will use.
 * It does NOT require building the project first — tsx resolves TypeScript directly.
 */

import path from "path"
import { fileURLToPath } from "url"

// tsx will resolve these path aliases via tsconfig.json
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const workspaceDir = path.resolve(__dirname, "..", "test-workspace")

async function run() {
	console.log("[test] Loading service-api...")

	// Dynamic import so errors are surfaced clearly
	const { createClineEngine } = await import("../src/service-api.js")

	const accessToken = process.env.SF_ACCESS_TOKEN
	const instanceUrl = process.env.SF_INSTANCE_URL

	if (!accessToken || !instanceUrl) {
		console.error("[test] Missing env vars: SF_ACCESS_TOKEN and SF_INSTANCE_URL are required")
		process.exit(1)
	}

	console.log("[test] Creating engine...")
	const engine = await createClineEngine({
		credentials: { accessToken, instanceUrl },
		version: "1.0.0-test",
	})

	console.log("[test] Engine created. Creating session in:", workspaceDir)
	const sessionId = await engine.createSession(workspaceDir)
	console.log("[test] Session created:", sessionId)

	// Subscribe to events BEFORE sending the message
	const emitter = engine.getEmitter(sessionId)

	emitter.on("agent_message_chunk", (payload) => {
		process.stdout.write(payload.text ?? "")
	})

	emitter.on("tool_call", (payload) => {
		console.log("\n[event:tool_call]", JSON.stringify(payload, null, 2))
	})

	emitter.on("end_turn", (payload) => {
		console.log("\n[event:end_turn] stop reason:", payload.stopReason)
	})

	emitter.on("error", (error) => {
		console.error("\n[event:error]", error)
	})

	console.log("\n[test] Sending message...")
	const message = "Can you please create a dogs.txt file here in the project with 5 different dog breeds in the file?"

	try {
		await engine.sendMessage(sessionId, message)
		console.log("\n[test] Message completed.")
	} catch (err) {
		console.error("\n[test] sendMessage failed:", err)
	}

	console.log("\n[test] Fetching conversation history...")
	const history = await engine.getConversationHistory(sessionId)
	if (history) {
		console.log("[test] Conversation history has", history.length, "messages")
		for (const msg of history) {
			const preview = typeof msg.content === "string" ? msg.content.slice(0, 80) : "[structured content]"
			console.log(`  [${msg.role}] ${preview}`)
		}
	} else {
		console.log("[test] No conversation history available")
	}

	console.log("\n[test] Shutting down engine...")
	await engine.shutdown()
	console.log("[test] Done.")
}

run().catch((err) => {
	console.error("[test] Fatal error:", err)
	process.exit(1)
})

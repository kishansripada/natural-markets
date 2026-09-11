import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

function required(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback
  if (!value) {
    throw new Error(`Missing required env var ${name}`)
  }
  return value
}

function optional(name: string, fallback = "") {
  return process.env[name] ?? fallback
}

export const config = {
  naturalApiKey: () => required("NATURAL_API_KEY"),
  naturalAgentId: () =>
    optional("NATURAL_AGENT_ID", "agt_01a02b0f13dc757db41512ee9d72eb1f"),
  naturalPerTxLimitCents: () =>
    Number(optional("NATURAL_PER_TX_LIMIT_CENTS", "100000")),
  slackBotToken: () => required("SLACK_BOT_TOKEN"),
  slackAppToken: () => required("SLACK_APP_TOKEN"),
  slackSigningSecret: () => optional("SLACK_SIGNING_SECRET"),
  openaiApiKey: () => optional("OPENAI_API_KEY"),
  openaiModel: () => optional("OPENAI_MODEL", "gpt-5.6-luna"),
  kalshiApiKeyId: () => optional("KALSHI_API_KEY_ID"),
  kalshiPrivateKeyPath: () => optional("KALSHI_PRIVATE_KEY_PATH"),
  kalshiPrivateKey: () => optional("KALSHI_PRIVATE_KEY"),
  resolveIntervalMs: () => Number(optional("RESOLVE_INTERVAL_MS", "60000")),
  storePath() {
    const file = optional(
      "STORE_PATH",
      path.join(process.cwd(), "data", "markets.json"),
    )
    mkdirSync(path.dirname(file), { recursive: true })
    return file
  },
}

export function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY)
}

export function envFileExists() {
  return existsSync(path.join(process.cwd(), ".env.local"))
}

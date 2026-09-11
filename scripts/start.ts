import { spawn } from "node:child_process"
import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })

const port = process.env.PORT || "3000"

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
  const bot = spawn(process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/bot.ts"], {
    stdio: "inherit",
    env: process.env,
  })
  bot.on("exit", (code) => {
    console.error("Slack bot exited", code)
    process.exit(code ?? 1)
  })
} else {
  console.warn("SLACK_BOT_TOKEN / SLACK_APP_TOKEN not set; Slack bot not started")
}

const web = spawn("npx", ["next", "start", "-p", port], {
  stdio: "inherit",
  env: process.env,
})
web.on("exit", (code) => {
  process.exit(code ?? 1)
})

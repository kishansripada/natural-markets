import "dotenv/config"
import { config as loadEnv } from "dotenv"
import { createSlackApp, startResolver } from "@/lib/slack/app"

loadEnv({ path: ".env.local" })

const app = createSlackApp()
await app.start()
await startResolver(app)
console.log("Natural Markets Slack bot is running (Bolt socket mode)")

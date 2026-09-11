import "dotenv/config"
import { config as loadEnv } from "dotenv"
loadEnv({ path: ".env.local" })

async function main() {
  const { runAgent } = await import("@/lib/agent")
  const { renderAgentMessage } = await import("@/lib/slack/render")

  const text = process.argv.slice(2).join(" ") || "what games are today"
  console.log(`USER: ${text}\n`)
  const outcome = await runAgent({
    text,
    userId: process.env.TEST_USER || "U_TEST",
    teamId: "T_TEST",
    channel: "C_TEST",
    thread: [],
  })
  console.log("RAW MODEL OUTPUT:\n" + outcome.text + "\n")
  const rendered = renderAgentMessage(outcome.text)
  console.log("RENDERED BLOCKS:\n" + JSON.stringify(rendered.blocks ?? rendered.text, null, 1))
  if (outcome.proposal) console.log("\nPROPOSAL CREATED:", outcome.proposal.id)
  if (outcome.pending) console.log("\nPENDING:", outcome.pending.id)
}

await main()

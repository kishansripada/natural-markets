import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })

async function main() {
  const key = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL || "gpt-5.6-luna"
  if (!key) throw new Error("OPENAI_API_KEY missing")

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: "Reply with exactly: luna-ok",
    }),
  })
  const data = (await response.json()) as {
    model?: string
    output_text?: string
    output?: { content?: { text?: string }[] }[]
    error?: { message?: string }
  }
  const text =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .map((part) => part.text)
      .filter(Boolean)
      .join("") ||
    data.error?.message
  console.log("status", response.status)
  console.log("model", data.model || model)
  console.log("reply", text)
}

await main()

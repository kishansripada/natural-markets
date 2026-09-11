import { generateText, stepCountIs } from "ai"
import { openai } from "@ai-sdk/openai"
import { config } from "@/lib/config"
import type { Bet } from "@/lib/db"

export type ResearchOutcome =
  | { result: "yes" | "no"; note: string }
  | { result: "unresolved"; note: string; checkAgainMinutes: number }

/**
 * Settle a custom bet by researching the real world. Runs with web search,
 * completely outside the Slack conversation, so nothing leaks to bettors
 * before settlement. Returns "unresolved" when the evidence isn't decisive
 * yet — the resolver will try again later.
 */
export async function researchBetOutcome(bet: Bet): Promise<ResearchOutcome> {
  const { text } = await generateText({
    model: openai.responses(config.openaiModel()),
    tools: { web_search: openai.tools.webSearch({}) },
    stopWhen: stepCountIs(8),
    system: `You are the neutral judge for a peer-to-peer bet. Real money moves on your answer, so only settle when the evidence is decisive.

Use web search to check the claim against current, reputable sources (official stats pages, major weather services, news wires, league sites). Prefer two agreeing sources for anything contested.

Reply with ONLY a JSON object on the last line, no markdown fences:
{"result":"yes"|"no"|"unresolved","note":"...","checkAgainMinutes":30}

- "yes" — the resolution criteria are clearly satisfied.
- "no" — clearly not satisfied.
- "unresolved" — the outcome isn't knowable yet (event hasn't happened, data not published, sources conflict). Include checkAgainMinutes: how long until it's worth checking again.
- note: one or two sentences a bettor would accept as proof — name the source and the figure/fact you found (e.g. "BOM reports Sydney Observatory Hill at 22.9°C (73.2°F) at 8:00am AEST — above the 70°F line."). For unresolved, say what you're waiting on.

Never decide from memory alone. If the criteria are about "right now", the time that matters is now, not when the bet was placed.`,
    prompt: `Bet: ${bet.marketTitle}

Resolution criteria (YES means): ${bet.resolutionCriteria}

Bet placed at: ${bet.createdAt}
Current time (UTC): ${new Date().toISOString()}`,
  })

  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    return {
      result: "unresolved",
      note: "Research pass returned no verdict.",
      checkAgainMinutes: 15,
    }
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      result?: string
      note?: string
      checkAgainMinutes?: number
    }
    const note = parsed.note || "No evidence summary given."
    if (parsed.result === "yes" || parsed.result === "no") {
      return { result: parsed.result, note }
    }
    return {
      result: "unresolved",
      note,
      checkAgainMinutes:
        typeof parsed.checkAgainMinutes === "number" &&
        parsed.checkAgainMinutes > 0
          ? Math.min(parsed.checkAgainMinutes, 24 * 60)
          : 15,
    }
  } catch {
    return {
      result: "unresolved",
      note: "Research pass returned an unreadable verdict.",
      checkAgainMinutes: 15,
    }
  }
}

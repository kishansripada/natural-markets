import type { KnownBlock } from "@slack/types"
import { jsxslack } from "jsx-slack"

/**
 * The agent writes its own jsx-slack markup. Compile it into Block Kit;
 * if it wrote plain text (or broken markup), fall back to a text post.
 *
 * Raw Slack tokens like <@U123>, <#C123>, or <!here> look like broken JSX
 * tags to the parser, so they are swapped for placeholders during parsing
 * and restored in the compiled JSON.
 */
export function renderAgentMessage(raw: string): {
  blocks?: KnownBlock[]
  text: string
} {
  const unfenced = raw
    .replace(/```(?:jsx|tsx|xml|html)?\n?([\s\S]*?)```/g, "$1")
    .trim()
  const shielded = unfenced.replace(
    /<([@#!][^<>]*)>/g,
    (_, inner: string) => `%%SLACK_${Buffer.from(inner, "utf8").toString("hex")}%%`,
  )
  const restore = (value: string) =>
    value.replace(/%%SLACK_([0-9a-f]+)%%/g, (_, hex: string) => `<${Buffer.from(hex, "hex").toString("utf8")}>`)

  const start = shielded.indexOf("<Blocks")
  const end = shielded.lastIndexOf("</Blocks>")
  const plain = restore(
    shielded
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  )
  if (start !== -1 && end > start) {
    const source = shielded.slice(start, end + "</Blocks>".length)
    try {
      const template = Object.assign([source], {
        raw: [source],
      }) as unknown as TemplateStringsArray
      const parsed = jsxslack(template) as KnownBlock[]
      if (Array.isArray(parsed) && parsed.length) {
        const restored = JSON.parse(restore(JSON.stringify(parsed))) as KnownBlock[]
        return { blocks: restored, text: plain.slice(0, 300) || "Market Maker" }
      }
    } catch {
      // Model wrote invalid markup — post the readable text instead.
    }
    return { text: plain }
  }
  return { text: restore(shielded) }
}

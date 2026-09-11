import { App, LogLevel, type SlackAction } from "@slack/bolt"
import { slackifyMarkdown } from "slackify-markdown"
import { config, hasOpenAi } from "@/lib/config"
import {
  getProposal,
  getProposalByMessage,
  linkUserToParty,
  listUsers,
  updateBet,
  updateProposal,
  upsertUser,
} from "@/lib/db"
import { runAgent, type ThreadTurn } from "@/lib/agent"
import {
  getOperatorPartyId,
  isOperatorEmail,
  syncCustomersToSlackUsers,
} from "@/lib/natural"
import { resolveLiveBets } from "@/lib/resolve"
import { renderAgentMessage } from "@/lib/slack/render"

type SlackClient = App["client"]

function actionValue(body: SlackAction) {
  if (!("actions" in body) || !body.actions?.[0]) return ""
  const first = body.actions[0]
  return "value" in first && first.value ? String(first.value) : ""
}

function actionMessageTs(body: SlackAction) {
  if ("message" in body && body.message && "ts" in body.message) {
    return String(body.message.ts)
  }
  return undefined
}

function stripMention(text: string, botUserId?: string) {
  return text
    .replace(botUserId ? new RegExp(`<@${botUserId}>`, "g") : /<@[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

type ThreadMessage = {
  user?: string
  text?: string
  bot_id?: string
}

function toThreadTurns(
  messages: ThreadMessage[],
  botUserId?: string,
): ThreadTurn[] {
  return messages
    .filter((item) => item.text)
    .map((item) => ({
      userId: item.user || "unknown",
      text: stripMention(item.text || "", botUserId),
      bot: Boolean(item.bot_id) || item.user === botUserId,
    }))
}

async function loadThreadMessages(
  client: SlackClient,
  channel: string,
  threadTs: string,
): Promise<ThreadMessage[]> {
  const replies = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 100,
  })
  return replies.messages ?? []
}

async function rememberUser(
  client: SlackClient,
  userId: string,
  teamId?: string,
) {
  try {
    const info = await client.users.info({ user: userId })
    const user = await upsertUser({
      slackUserId: userId,
      slackTeamId: teamId || info.user?.team_id || "unknown",
      slackName: info.user?.real_name || info.user?.name || null,
    })
    // The operator's own account never needs a delegation invite —
    // recognize them by Slack profile email and link silently.
    const profileEmail = info.user?.profile?.email
    if (!user?.naturalPartyId && profileEmail && isOperatorEmail(profileEmail)) {
      await linkUserToParty({
        slackUserId: userId,
        naturalPartyId: await getOperatorPartyId(),
      })
    }
    return user
  } catch {
    return upsertUser({
      slackUserId: userId,
      slackTeamId: teamId || "unknown",
      slackName: null,
      slackEmail: null,
    })
  }
}

/** Reactions are decoration — never let them break a turn. */
async function react(
  client: SlackClient,
  action: "add" | "remove",
  channel: string,
  timestamp: string,
  name: string,
) {
  try {
    await client.reactions[action]({ channel, timestamp, name })
  } catch (error) {
    const code = (error as { data?: { error?: string } })?.data?.error
    if (code !== "already_reacted" && code !== "no_reaction") {
      console.error(`reaction ${action} ${name} failed`, code || error)
    }
  }
}

/**
 * One path for everything: run the agent, post whatever it wrote,
 * record message timestamps for anything it created.
 */
async function postAgentTurn(
  client: SlackClient,
  input: {
    channel: string
    threadTs?: string
    run: Parameters<typeof runAgent>[0]
  },
) {
  if (!hasOpenAi()) {
    await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "I need OPENAI_API_KEY set to think. Add it and restart me.",
    })
    return
  }
  try {
    const outcome = await runAgent(input.run)
    // Passive turns may decide the message wasn't for the bot.
    if (input.run.passive && /^["'`\s]*NO_REPLY["'`\s]*$/.test(outcome.text)) {
      return
    }
    if (!outcome.text) throw new Error("agent returned an empty reply")
    const rendered = renderAgentMessage(outcome.text)
    const posted = await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      ...(rendered.blocks
        ? { text: rendered.text, blocks: rendered.blocks }
        : { text: slackifyMarkdown(rendered.text) }),
    })
    if (outcome.proposal) {
      await updateProposal(outcome.proposal.id, {
        messageTs: posted.ts ?? null,
        threadTs: input.threadTs || posted.ts || null,
      })
      // 👀 on the primary channel message = this bet still needs a taker.
      const root = input.threadTs || posted.ts
      if (root) {
        await react(client, "add", input.channel, root, "eyes")
      }
    }
    if (outcome.bet && posted.ts) {
      await updateBet(outcome.bet.id, { messageTs: posted.ts })
    }
    if (outcome.bet) {
      // Bet is set with both sides: swap 👀 for ✅ on the primary message.
      const origin = outcome.bet.proposalId
        ? await getProposal(outcome.bet.proposalId)
        : null
      const root = origin?.threadTs || input.threadTs || posted.ts
      if (root) {
        await react(client, "add", input.channel, root, "white_check_mark")
        await react(client, "remove", input.channel, root, "eyes")
      }
    }
  } catch (error) {
    console.error("agent turn failed", error)
    // Don't spam bystander conversations with error messages.
    if (input.run.passive) return
    await client.chat.postMessage({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: "Something broke on my end mid-thought. Try that again.",
    })
  }
}

export function createSlackApp() {
  const app = new App({
    token: config.slackBotToken(),
    appToken: config.slackAppToken(),
    signingSecret: config.slackSigningSecret() || undefined,
    socketMode: true,
    logLevel: LogLevel.INFO,
  })

  app.event("app_mention", async ({ event, context, client }) => {
    if (!event.text || !event.user || event.bot_id) return
    const botUserId = context.botUserId
    const text = stripMention(event.text, botUserId)
    if (!text) return
    await rememberUser(client, event.user, event.team)
    const rootTs = event.thread_ts || event.ts
    const thread = event.thread_ts
      ? toThreadTurns(
          await loadThreadMessages(client, event.channel, rootTs),
          botUserId,
        )
      : []
    await postAgentTurn(client, {
      channel: event.channel,
      threadTs: rootTs,
      run: {
        text,
        userId: event.user,
        teamId: event.team || "unknown",
        channel: event.channel,
        openProposal: await getProposalByMessage(event.channel, rootTs),
        thread,
      },
    })
  })

  // Replies inside a thread the bot was summoned into reach the agent without
  // a fresh @mention — it decides for itself whether the message needs it.
  app.event("message", async ({ event, context, client }) => {
    if (event.subtype) return
    const msg = event as typeof event & {
      user?: string
      text?: string
      thread_ts?: string
      bot_id?: string
    }
    if (!msg.user || !msg.text || msg.bot_id) return
    if (!msg.thread_ts || msg.thread_ts === msg.ts) return
    const botUserId = context.botUserId
    if (!botUserId || msg.user === botUserId) return
    // Fresh @mentions in the thread arrive as app_mention — skip the duplicate.
    if (msg.text.includes(`<@${botUserId}>`)) return

    const messages = await loadThreadMessages(client, msg.channel, msg.thread_ts)
    const root = messages[0]
    const botThread =
      Boolean(root) &&
      (root.user === botUserId || (root.text ?? "").includes(`<@${botUserId}>`))
    if (!botThread) return

    await rememberUser(client, msg.user, context.teamId)
    await postAgentTurn(client, {
      channel: msg.channel,
      threadTs: msg.thread_ts,
      run: {
        text: stripMention(msg.text, botUserId),
        passive: true,
        userId: msg.user,
        teamId: context.teamId || "unknown",
        channel: msg.channel,
        openProposal: await getProposalByMessage(msg.channel, msg.thread_ts),
        thread: toThreadTurns(messages, botUserId),
      },
    })
  })

  const buttonEvent = (label: string) =>
    async ({ ack, body, client }: { ack: () => Promise<void>; body: SlackAction; client: SlackClient }) => {
      await ack()
      const userId = body.user.id
      const proposalId = actionValue(body)
      const channel = "channel" in body ? body.channel?.id : undefined
      if (!proposalId || !channel) return
      await rememberUser(client, userId, body.team?.id)
      await postAgentTurn(client, {
        channel,
        threadTs: actionMessageTs(body),
        run: {
          text: `<@${userId}> clicked the "${label}" button on proposal ${proposalId}.`,
          event: true,
          userId,
          teamId: body.team?.id || "unknown",
          channel,
        },
      })
    }

  app.action("take_other_side", buttonEvent("Take the other side"))
  app.action("confirm_bet", buttonEvent("Confirm"))
  app.action("decline_bet", buttonEvent("Decline"))
  app.action(
    "connect_natural",
    buttonEvent("Connect Natural (they have not typed an email yet)"),
  )

  return app
}

export async function startResolver(app: App) {
  const tick = async () => {
    await syncCustomersToSlackUsers()
    const settled = await resolveLiveBets()
    for (const bet of settled) {
      if (!bet) continue
      await postAgentTurn(app.client, {
        channel: bet.channelId,
        threadTs: bet.messageTs || undefined,
        run: {
          text: `Bet ${bet.id} (${bet.marketTitle}) settled ${String(bet.kalshiResult).toUpperCase()}. Winner: <@${bet.winnerSlackId}>. ${
            bet.resolutionNote ? `Resolution evidence: ${bet.resolutionNote} ` : ""
          }${
            bet.payoutPaymentId
              ? `Payout sent via Natural (payment ${bet.payoutPaymentId}).`
              : `Payout failed: ${bet.payoutError || "unknown error"}.`
          } Announce the result${bet.resolutionNote ? ", including the evidence" : ""}.`,
          event: true,
          userId: bet.winnerSlackId || "system",
          teamId: bet.teamId,
          channel: bet.channelId,
        },
      })
    }
  }
  await tick()
  return setInterval(() => {
    tick().catch((error) => {
      console.error("resolve tick failed", error)
    })
  }, config.resolveIntervalMs())
}

export async function connectedCustomerCount() {
  return (await listUsers()).filter((user) => user.naturalPartyId).length
}

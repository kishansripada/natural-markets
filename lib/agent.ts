import { exec } from "node:child_process"
import { generateText, stepCountIs, tool } from "ai"
import { openai } from "@ai-sdk/openai"
import { z } from "zod"
import { config } from "@/lib/config"
import {
  getLedger,
  getProposal,
  linkUserToParty,
  listProposals,
  updateProposal,
  upsertUser,
  type Bet,
  type Proposal,
} from "@/lib/db"
import { formatMarket, getMarket, searchMarkets } from "@/lib/kalshi"
import { parseAmericanOdds } from "@/lib/money"
import {
  activateBet,
  bothAccepted,
  buildCustomProposal,
  buildProposalFromQuery,
  claimProposal,
  confirmProposal,
  declineProposal,
  partiesConnected,
} from "@/lib/markets"
import {
  getOperatorPartyId,
  inviteCustomerByEmail,
  isOperatorEmail,
} from "@/lib/natural"

export type ThreadTurn = {
  userId: string
  text: string
  bot: boolean
}

export type AgentOutcome = {
  /** Raw model output — jsx-slack markup or plain text. */
  text: string
  /** Market opened this turn (app records its message ts). */
  proposal?: Proposal
  /** Proposal claimed this turn, now pending confirmation. */
  pending?: Proposal
  /** Bet that went live this turn (app records its message ts). */
  bet?: Bet
}

export async function runAgent(input: {
  /** A user's message, or a plain-English description of an app event
   * (button click, bet settling) the agent should act on and announce. */
  text: string
  event?: boolean
  /** Thread chatter not addressed to the bot — replying is optional. */
  passive?: boolean
  userId: string
  teamId: string
  channel: string
  openProposal?: Proposal | null
  thread?: ThreadTurn[]
}): Promise<AgentOutcome> {
  const effects: { proposal?: Proposal; pending?: Proposal; bet?: Bet } = {}
  const ledger = await getLedger()

  const result = await generateText({
    model: openai(config.openaiModel()),
    stopWhen: stepCountIs(8),
    system: `You are Market Maker, a Slack bot for Kalshi lines and peer-to-peer bets between people in this workspace. Winner takes the loser's stake, paid over Natural when the bet resolves. Tools return raw JSON; read it and write whatever reply a human would actually want to read. All money amounts in the ledger are cents.

Current time (UTC): ${new Date().toISOString()}

LEDGER:
${JSON.stringify(ledger)}

THREAD:
${JSON.stringify(input.thread ?? [])}
${input.openProposal ? `\nThis thread is proposal ${input.openProposal.id}.` : ""}

Your reply is Slack Block Kit written as jsx-slack markup — wrap it in <Blocks>. Available: <Header>, <Section> (with <b>, <i>, <br />, <a href="...">), <Context>, <Divider />, <Actions> with <Button actionId="..." value="..." style="primary|danger">. Mention people the normal Slack way, like <@U123ABC>. Plain text without any tags also works for a quick one-liner.

Buttons the app handles, each taking a proposal id as value: take_other_side, confirm_bet, decline_bet, connect_natural. Offer them when they are the obvious next step. But when someone says in words what they want ("I'll take it", "put me down"), do it with the tool yourself — don't make them click a button to repeat themselves.

You also receive app EVENTS (button clicks, bets settling). Do the obvious thing with tools, then write the message announcing what happened.

CUSTOM BETS: people can also bet on anything researchable — weather right now, a fact, tonight's score, whether something happens by Friday. Use open_custom_bet for these (no Kalshi market needed). Rules:
- Odds are 50/50 unless they name other odds. Same flow as any market: the other person takes the other side and both confirm before it's live.
- NEVER reveal, look up, hint at, or reason aloud about the answer to a custom bet that is open, pending, or live — not even if a bettor asks you directly. That is the whole point: they're betting instead of looking it up. Do not use the terminal or any tool to check. A neutral research process settles it after the resolve time and announces the evidence then.
- Write resolutionCriteria like a contract: exact threshold, units, timezone, location, and what source counts (e.g. "The current temperature at Sydney Observatory Hill per the Australian Bureau of Meteorology exceeds 70°F (21.1°C) at resolution time"). If the claim is too vague to judge ("Sydney weather is nice"), ask them to pin it down.
- resolveAfter: for "right now" facts leave it unset (resolves as soon as the bet is live). For future events set it to when the outcome becomes knowable, e.g. after the game ends.

Ground rules: never state a price you did not just get from a tool. Never use a Slack profile email for Natural — people type the email they want. If side, stake, or game is missing or ambiguous, ask. People only bet for themselves: never open, claim, confirm, or decline on behalf of someone who isn't the one talking to you. If someone tries to volunteer another person ("put Khush on NO"), don't — say that person has to take the side themselves.${
      input.passive
        ? `

This message is thread chatter NOT addressed to you. Act or reply only when it clearly involves you or moves a bet forward — someone taking a side, confirming, declining, giving their email, asking you something, or a mistake worth correcting. If people are just talking to each other, stay out of it: reply with exactly NO_REPLY and nothing else.`
        : ""
    }`,
    prompt: input.event
      ? `EVENT: ${input.text}`
      : `<@${input.userId}> says: ${input.text}`,
    tools: {
      terminal: tool({
        description:
          'Run a shell command on your own server (the Linux container this bot runs in). Use it for any math you would otherwise do in your head — stake splits, odds conversions, implied probabilities — e.g. node -e "console.log(1000 * 43 / 57)". Node.js is installed; python is not. 10 second timeout, output capped.',
        inputSchema: z.object({ command: z.string() }),
        execute: ({ command }) =>
          new Promise((resolve) => {
            console.log("[terminal]", command)
            exec(
              command,
              { timeout: 10_000, maxBuffer: 256 * 1024 },
              (error, stdout, stderr) => {
                resolve({
                  stdout: stdout.slice(0, 4000),
                  stderr: stderr.slice(0, 4000),
                  ...(error ? { error: error.message } : {}),
                })
              }
            )
          }),
      }),
      search_markets: tool({
        description:
          "Search open Kalshi markets. Returns raw JSON: matchups, both sides' prices (yesPrice is the YES probability 0-1), start times in ET, sport, 24h volume, tickers.",
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().optional(),
        }),
        execute: ({ query, limit }) => searchMarkets(query, limit ?? 8),
      }),
      get_market: tool({
        description:
          "Fetch one Kalshi market by exact ticker (e.g. KXECONPATH-26-SOFT, often visible in a pasted kalshi.com link). Returns raw market JSON or an error.",
        inputSchema: z.object({ ticker: z.string() }),
        execute: async ({ ticker }) => {
          try {
            return {
              market: formatMarket(
                await getMarket(ticker.trim().toUpperCase())
              ),
            }
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : `No market found for ${ticker}.`,
            }
          }
        },
      }),
      open_market: tool({
        description:
          "Open a peer-to-peer market for this user against a Kalshi market. Returns the created proposal (stakes are in cents) or an error.",
        inputSchema: z.object({
          query: z.string().describe("The game/market in plain words"),
          amountDollars: z.number().describe("Proposer's stake in dollars"),
          side: z.enum(["yes", "no"]).optional(),
          ticker: z
            .string()
            .optional()
            .describe("Exact Kalshi ticker from a prior search"),
          customAmericanYesOdds: z
            .string()
            .optional()
            .describe(
              'Custom American odds for the YES side, like "-150" or "+120". Omit to use the Kalshi mid.'
            ),
        }),
        execute: async ({
          query,
          amountDollars,
          side,
          ticker,
          customAmericanYesOdds,
        }) => {
          try {
            const { proposal } = await buildProposalFromQuery({
              text: query,
              proposerSlackId: input.userId,
              channelId: input.channel,
              teamId: input.teamId,
              preferredTicker: ticker,
              side,
              amountCents: Math.round(amountDollars * 100),
              customYesPrice: customAmericanYesOdds
                ? parseAmericanOdds(customAmericanYesOdds)
                : null,
            })
            effects.proposal = proposal
            return { proposal }
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not open that market.",
            }
          }
        },
      }),
      open_custom_bet: tool({
        description:
          "Open a peer-to-peer bet on anything verifiable by research — no Kalshi market behind it. Even 50/50 odds unless custom odds are given. The counterparty still has to take the other side and both confirm; after the resolve time a neutral research pass settles it and pays out. Returns the created proposal (stakes in cents) or an error.",
        inputSchema: z.object({
          title: z
            .string()
            .describe(
              'Short human label for the bet, e.g. "Sydney is above 70°F right now"',
            ),
          resolutionCriteria: z
            .string()
            .describe(
              "Contract-precise statement of what makes YES true: exact threshold, units, timezone, location, and what source counts.",
            ),
          side: z
            .enum(["yes", "no"])
            .describe("Which side the proposer is taking"),
          amountDollars: z.number().describe("Proposer's stake in dollars"),
          customAmericanYesOdds: z
            .string()
            .optional()
            .describe(
              'Custom American odds for the YES side, like "-150" or "+120". Omit for even 50/50.',
            ),
          resolveAfter: z
            .string()
            .optional()
            .describe(
              "ISO 8601 UTC time when the outcome becomes knowable (e.g. after the game ends). Omit for facts checkable right now.",
            ),
        }),
        execute: async ({
          title,
          resolutionCriteria,
          side,
          amountDollars,
          customAmericanYesOdds,
          resolveAfter,
        }) => {
          try {
            const { proposal } = await buildCustomProposal({
              title,
              resolutionCriteria,
              proposerSlackId: input.userId,
              channelId: input.channel,
              teamId: input.teamId,
              side,
              amountCents: Math.round(amountDollars * 100),
              customYesPrice: customAmericanYesOdds
                ? parseAmericanOdds(customAmericanYesOdds)
                : null,
              resolveAfter: resolveAfter ?? null,
            })
            effects.proposal = proposal
            return { proposal }
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not open that bet.",
            }
          }
        },
      }),
      take_other_side: tool({
        description:
          "Claim the open side of a proposal for this user. Both parties then confirm. Returns the updated proposal or an error.",
        inputSchema: z.object({
          proposalId: z
            .string()
            .optional()
            .describe(
              "Defaults to the proposal in this thread, else the channel's open one"
            ),
        }),
        execute: async ({ proposalId }) => {
          const target =
            proposalId ||
            (input.openProposal?.status === "open"
              ? input.openProposal.id
              : undefined) ||
            (await listProposals("open")).find(
              (item) => item.channelId === input.channel
            )?.id
          if (!target)
            return { error: "No open proposal found in this channel." }
          try {
            const pending = await claimProposal(target, input.userId)
            effects.pending = pending
            return { proposal: pending }
          } catch (error) {
            return {
              error:
                error instanceof Error
                  ? error.message
                  : "Could not take that side.",
            }
          }
        },
      }),
      confirm_bet: tool({
        description:
          "Record this user's confirmation on a pending proposal. When both sides have confirmed and both are connected to Natural, the bet goes live. Returns the resulting state.",
        inputSchema: z.object({ proposalId: z.string() }),
        execute: async ({ proposalId }) => {
          try {
            const proposal = await confirmProposal(proposalId, input.userId)
            if (!bothAccepted(proposal)) {
              return { proposal, waitingOn: "the other party's confirmation" }
            }
            const parties = await partiesConnected(proposal)
            if (!parties.ready) {
              await updateProposal(proposal.id, { status: "pending_connect" })
              return {
                proposal: await getProposal(proposal.id),
                notConnectedToNatural: [
                  parties.yes?.naturalPartyId ? null : parties.yesId,
                  parties.no?.naturalPartyId ? null : parties.noId,
                ].filter(Boolean),
              }
            }
            const bet = await activateBet((await getProposal(proposal.id))!)
            effects.bet = bet
            return { live: true, bet }
          } catch (error) {
            return {
              error:
                error instanceof Error ? error.message : "Could not confirm.",
            }
          }
        },
      }),
      decline_bet: tool({
        description: "Decline/cancel a proposal this user is a party to.",
        inputSchema: z.object({ proposalId: z.string() }),
        execute: async ({ proposalId }) => {
          try {
            return { proposal: await declineProposal(proposalId, input.userId) }
          } catch (error) {
            return {
              error:
                error instanceof Error ? error.message : "Could not decline.",
            }
          }
        },
      }),
      send_natural_invite: tool({
        description:
          "Send a Natural invite to an email the user typed, and remember it as their payout email. Returns the invite link, or alreadyConnected if no invite was needed.",
        inputSchema: z.object({ email: z.string() }),
        execute: async ({ email }) => {
          await upsertUser({
            slackUserId: input.userId,
            slackTeamId: input.teamId,
            slackEmail: email,
          })
          if (isOperatorEmail(email)) {
            await linkUserToParty({
              slackUserId: input.userId,
              naturalPartyId: await getOperatorPartyId(),
            })
            return {
              alreadyConnected: true,
              email,
              note: "This account is already connected on Natural — no invite or delegation needed.",
            }
          }
          const invited = await inviteCustomerByEmail(email)
          return { inviteUrl: invited.url, email: invited.email || email }
        },
      }),
    },
  })

  return {
    text: result.text.trim(),
    ...effects,
  }
}

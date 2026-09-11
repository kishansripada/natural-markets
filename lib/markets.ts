import {
  type Bet,
  type Proposal,
  getProposal,
  getUser,
  insertBet,
  insertProposal,
  newId,
  timestamp,
  updateProposal,
} from "@/lib/db"
import { formatMarket, getMarket, searchMarkets } from "@/lib/kalshi"
import { type Side, centsToPrice, matchStakes, priceToCents } from "@/lib/money"

export async function buildProposalFromQuery(input: {
  text: string
  proposerSlackId: string
  channelId: string
  teamId: string
  preferredTicker?: string
  side?: Side | null
  amountCents: number
  customYesPrice?: number | null
}) {
  const amountCents = input.amountCents
  if (!amountCents || amountCents <= 0) {
    throw new Error("Say how much you want to put down, like $25.")
  }

  let market = null
  if (input.preferredTicker) {
    try {
      market = formatMarket(await getMarket(input.preferredTicker.trim().toUpperCase()))
    } catch {
      // Not a valid ticker — fall back to search.
    }
  }
  if (!market) {
    const search = await searchMarkets(input.text)
    market =
      search.markets.find((item) => item.ticker === input.preferredTicker) ??
      search.markets[0] ??
      null
  }
  if (!market) {
    throw new Error("I could not find a matching Kalshi market for that.")
  }

  const side = input.side ?? "yes"
  const yesPrice = input.customYesPrice ?? market.yesPrice
  const stakes = matchStakes({
    proposerSide: side,
    proposerStakeCents: amountCents,
    yesPrice,
  })

  const createdAt = timestamp()
  const proposal: Proposal = {
    id: newId("mkt"),
    status: "open",
    channelId: input.channelId,
    teamId: input.teamId,
    messageTs: null,
    threadTs: null,
    proposerSlackId: input.proposerSlackId,
    counterpartySlackId: null,
    proposerAccepted: 1,
    counterpartyAccepted: 0,
    kalshiTicker: market.ticker,
    kalshiEventTicker: market.eventTicker,
    marketTitle: market.title,
    yesSubtitle: market.yesSubtitle,
    noSubtitle: market.noSubtitle,
    proposerSide: side,
    yesPriceCents: priceToCents(yesPrice),
    oddsSource: input.customYesPrice ? "custom" : "kalshi",
    proposerStakeCents: amountCents,
    counterpartyStakeCents:
      side === "yes" ? stakes.noStakeCents : stakes.yesStakeCents,
    yesStakeCents: stakes.yesStakeCents,
    noStakeCents: stakes.noStakeCents,
    potCents: stakes.potCents,
    rawQuery: input.text,
    resolutionCriteria: null,
    resolveAfter: null,
    createdAt,
    updatedAt: createdAt,
  }
  await insertProposal(proposal)
  return { proposal, market }
}

/** A bet on anything verifiable — no Kalshi market behind it. The bot itself
 * researches the answer once resolveAfter passes. Defaults to even odds. */
export async function buildCustomProposal(input: {
  title: string
  resolutionCriteria: string
  proposerSlackId: string
  channelId: string
  teamId: string
  side: Side
  amountCents: number
  customYesPrice?: number | null
  resolveAfter?: string | null
}) {
  if (!input.amountCents || input.amountCents <= 0) {
    throw new Error("Say how much you want to put down, like $25.")
  }
  const yesPrice = input.customYesPrice ?? 0.5
  const stakes = matchStakes({
    proposerSide: input.side,
    proposerStakeCents: input.amountCents,
    yesPrice,
  })
  const createdAt = timestamp()
  const proposal: Proposal = {
    id: newId("mkt"),
    status: "open",
    channelId: input.channelId,
    teamId: input.teamId,
    messageTs: null,
    threadTs: null,
    proposerSlackId: input.proposerSlackId,
    counterpartySlackId: null,
    proposerAccepted: 1,
    counterpartyAccepted: 0,
    kalshiTicker: null,
    kalshiEventTicker: null,
    marketTitle: input.title,
    yesSubtitle: null,
    noSubtitle: null,
    proposerSide: input.side,
    yesPriceCents: priceToCents(yesPrice),
    oddsSource: "custom",
    proposerStakeCents: input.amountCents,
    counterpartyStakeCents:
      input.side === "yes" ? stakes.noStakeCents : stakes.yesStakeCents,
    yesStakeCents: stakes.yesStakeCents,
    noStakeCents: stakes.noStakeCents,
    potCents: stakes.potCents,
    rawQuery: null,
    resolutionCriteria: input.resolutionCriteria,
    resolveAfter: input.resolveAfter ?? createdAt,
    createdAt,
    updatedAt: createdAt,
  }
  await insertProposal(proposal)
  return { proposal }
}

export async function claimProposal(
  proposalId: string,
  counterpartySlackId: string,
) {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error("That market is gone.")
  if (proposal.status !== "open") throw new Error("That market is no longer open.")
  if (proposal.proposerSlackId === counterpartySlackId) {
    throw new Error("You already have one side of this market.")
  }
  return (await updateProposal(proposalId, {
    status: "pending",
    counterpartySlackId,
    counterpartyAccepted: 1,
  }))!
}

export async function confirmProposal(proposalId: string, slackUserId: string) {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error("That market is gone.")
  if (proposal.status !== "pending" && proposal.status !== "pending_connect") {
    throw new Error("This market is not waiting on confirmation.")
  }
  const patch: Partial<Proposal> = {}
  if (slackUserId === proposal.proposerSlackId) patch.proposerAccepted = 1
  else if (slackUserId === proposal.counterpartySlackId) patch.counterpartyAccepted = 1
  else throw new Error("You are not a party to this market.")
  return (await updateProposal(proposalId, patch))!
}

export async function declineProposal(proposalId: string, slackUserId: string) {
  const proposal = await getProposal(proposalId)
  if (!proposal) throw new Error("That market is gone.")
  if (
    slackUserId !== proposal.proposerSlackId &&
    slackUserId !== proposal.counterpartySlackId
  ) {
    throw new Error("You are not a party to this market.")
  }
  return (await updateProposal(proposalId, { status: "cancelled" }))!
}

export function bothAccepted(proposal: Proposal) {
  return proposal.proposerAccepted === 1 && proposal.counterpartyAccepted === 1
}

export async function partiesConnected(proposal: Proposal) {
  const yesId =
    proposal.proposerSide === "yes"
      ? proposal.proposerSlackId
      : proposal.counterpartySlackId
  const noId =
    proposal.proposerSide === "no"
      ? proposal.proposerSlackId
      : proposal.counterpartySlackId
  const yes = yesId ? await getUser(yesId) : null
  const no = noId ? await getUser(noId) : null
  return {
    yesId,
    noId,
    yes,
    no,
    ready: Boolean(yes?.naturalPartyId && no?.naturalPartyId),
  }
}

export async function activateBet(proposal: Proposal): Promise<Bet> {
  const parties = await partiesConnected(proposal)
  if (!parties.ready || !parties.yesId || !parties.noId) {
    await updateProposal(proposal.id, { status: "pending_connect" })
    throw new Error("Both people need to connect Natural before this can go live.")
  }
  const createdAt = timestamp()
  const bet: Bet = {
    id: newId("bet"),
    proposalId: proposal.id,
    status: "live",
    channelId: proposal.channelId,
    teamId: proposal.teamId,
    messageTs: proposal.messageTs,
    yesSlackId: parties.yesId,
    noSlackId: parties.noId,
    yesPartyId: parties.yes?.naturalPartyId ?? null,
    noPartyId: parties.no?.naturalPartyId ?? null,
    kalshiTicker: proposal.kalshiTicker,
    kalshiEventTicker: proposal.kalshiEventTicker,
    marketTitle: proposal.marketTitle,
    yesSubtitle: proposal.yesSubtitle,
    noSubtitle: proposal.noSubtitle,
    yesPriceCents: proposal.yesPriceCents,
    oddsSource: proposal.oddsSource,
    yesStakeCents: proposal.yesStakeCents,
    noStakeCents: proposal.noStakeCents,
    potCents: proposal.potCents,
    kalshiResult: null,
    winnerSlackId: null,
    payoutPaymentId: null,
    payoutError: null,
    resolvedAt: null,
    resolutionCriteria: proposal.resolutionCriteria ?? null,
    resolveAfter: proposal.resolveAfter ?? null,
    resolutionNote: null,
    createdAt,
    updatedAt: createdAt,
  }
  await insertBet(bet)
  await updateProposal(proposal.id, { status: "live" })
  return bet
}

export function describeOdds(proposal: Proposal) {
  const price = centsToPrice(proposal.yesPriceCents)
  return {
    yesLabel: proposal.yesSubtitle || "Yes",
    noLabel: proposal.noSubtitle || "No",
    price,
  }
}

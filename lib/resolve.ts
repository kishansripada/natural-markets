import { listBets, updateBet, timestamp, type Bet } from "@/lib/db"
import { getMarket, isResolved } from "@/lib/kalshi"
import { payoutAmount, type Side } from "@/lib/money"
import { payBetweenCustomers } from "@/lib/natural"
import { researchBetOutcome } from "@/lib/research"

export async function resolveLiveBets() {
  const live = await listBets("live")
  const settled = []

  for (const bet of live) {
    if (bet.kalshiTicker) {
      let market
      try {
        market = await getMarket(bet.kalshiTicker)
      } catch {
        continue
      }
      if (!isResolved(market)) continue
      const result = market.result === "yes" ? "yes" : "no"
      settled.push(
        await settleBet(bet, {
          result,
          description: `Kalshi ${bet.kalshiTicker} settled ${result}: ${bet.marketTitle}`,
          resolutionNote: null,
        }),
      )
      continue
    }

    // Custom bet: the bot itself is the oracle. Wait for the resolve window,
    // then research the outcome. Undecided verdicts push the window forward.
    if (!bet.resolutionCriteria) continue
    if (bet.resolveAfter && new Date(bet.resolveAfter) > new Date()) continue

    let verdict
    try {
      verdict = await researchBetOutcome(bet)
    } catch (error) {
      console.error("research failed for", bet.id, error)
      await updateBet(bet.id, {
        resolveAfter: new Date(Date.now() + 15 * 60_000).toISOString(),
      })
      continue
    }
    if (verdict.result === "unresolved") {
      console.log("[resolve]", bet.id, "unresolved:", verdict.note)
      await updateBet(bet.id, {
        resolveAfter: new Date(
          Date.now() + verdict.checkAgainMinutes * 60_000,
        ).toISOString(),
      })
      continue
    }
    settled.push(
      await settleBet(bet, {
        result: verdict.result,
        description: `Bet settled ${verdict.result}: ${bet.marketTitle} — ${verdict.note}`.slice(
          0,
          500,
        ),
        resolutionNote: verdict.note,
      }),
    )
  }

  return settled.filter(Boolean)
}

async function settleBet(
  bet: Bet,
  input: { result: Side; description: string; resolutionNote: string | null },
) {
  const { result } = input
  const winnerSlackId = result === "yes" ? bet.yesSlackId : bet.noSlackId
  const loserPartyId = result === "yes" ? bet.noPartyId : bet.yesPartyId
  const winnerPartyId = result === "yes" ? bet.yesPartyId : bet.noPartyId
  const amount = payoutAmount({
    result,
    yesStakeCents: bet.yesStakeCents,
    noStakeCents: bet.noStakeCents,
  })

  if (!loserPartyId || !winnerPartyId) {
    return updateBet(bet.id, {
      status: "payout_failed",
      kalshiResult: result,
      winnerSlackId,
      payoutError: "Missing Natural party id on one side",
      resolutionNote: input.resolutionNote,
      resolvedAt: timestamp(),
    })
  }

  try {
    const paymentId = await payBetweenCustomers({
      fromPartyId: loserPartyId,
      toPartyId: winnerPartyId,
      amountCents: amount,
      description: input.description,
      betId: bet.id,
    })
    return updateBet(bet.id, {
      status: "settled",
      kalshiResult: result,
      winnerSlackId,
      payoutPaymentId: paymentId,
      payoutError: null,
      resolutionNote: input.resolutionNote,
      resolvedAt: timestamp(),
    })
  } catch (error) {
    return updateBet(bet.id, {
      status: "payout_failed",
      kalshiResult: result,
      winnerSlackId,
      payoutError: error instanceof Error ? error.message : "payout failed",
      resolutionNote: input.resolutionNote,
      resolvedAt: timestamp(),
    })
  }
}

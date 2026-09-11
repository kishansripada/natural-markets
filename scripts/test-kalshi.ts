import { config as loadEnv } from "dotenv"

loadEnv({ path: ".env.local" })

const { getBalance, getExchangeStatus, getMarket, hasKalshiAuth, searchMarkets } =
  await import("@/lib/kalshi")

async function main() {
  console.log("auth configured:", hasKalshiAuth())
  const status = await getExchangeStatus()
  console.log("exchange:", status)

  try {
    const balance = await getBalance()
    const keys = Object.keys(balance)
    console.log("authenticated balance ok, keys:", keys.join(", ") || "(empty)")
  } catch (error) {
    console.log(
      "authenticated balance failed:",
      error instanceof Error ? error.message : error,
    )
  }

  const search = await searchMarkets("boston game today")
  console.log("todayET:", search.todayET)
  console.log(
    "markets:",
    search.markets.map(
      (market) =>
        `${market.sport} ${market.title} ${Math.round(market.yesPrice * 100)}¢ ${market.startLabel} ${market.ticker}`,
    ),
  )

  const first = search.markets[0]
  if (first) {
    const market = await getMarket(first.ticker)
    console.log("market detail:", {
      ticker: market.ticker,
      status: market.status,
      yes_bid: market.yes_bid_dollars,
      yes_ask: market.yes_ask_dollars,
      close_time: market.close_time,
      result: market.result || "(open)",
    })
  }
}

await main()

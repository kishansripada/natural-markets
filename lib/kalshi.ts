import { createSign, constants } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { config } from "@/lib/config"

const KALSHI_HOST = "https://external-api.kalshi.com"
const KALSHI_BASE = `${KALSHI_HOST}/trade-api/v2`

function kalshiPrivateKey() {
  const inline = config.kalshiPrivateKey()
  if (inline) return inline.replaceAll("\\n", "\n")
  const file = config.kalshiPrivateKeyPath()
  if (file && existsSync(file)) return readFileSync(file, "utf8")
  return ""
}

function kalshiAuthHeaders(method: string, url: URL) {
  const keyId = config.kalshiApiKeyId()
  const privateKey = kalshiPrivateKey()
  if (!keyId || !privateKey) return {}
  const timestamp = Date.now().toString()
  const signPath = url.pathname
  const message = `${timestamp}${method.toUpperCase()}${signPath}`
  const sign = createSign("RSA-SHA256")
  sign.update(message)
  sign.end()
  const signature = sign.sign({
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  })
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
  }
}

export type KalshiMarket = {
  ticker: string
  event_ticker: string
  title?: string
  yes_sub_title?: string
  no_sub_title?: string
  status: string
  result?: string
  yes_bid_dollars?: string
  yes_ask_dollars?: string
  no_bid_dollars?: string
  no_ask_dollars?: string
  last_price_dollars?: string
  close_time?: string
  expected_expiration_time?: string
  rules_primary?: string
  event_title?: string
  series_ticker?: string
  volume_fp?: string
  volume_24h_fp?: string
  open_interest_fp?: string
}

export type KalshiEvent = {
  event_ticker: string
  series_ticker: string
  title: string
  category?: string
  markets?: KalshiMarket[]
}

type Series = { ticker: string; title: string; category?: string }

let seriesCache: { at: number; series: Series[] } | null = null

async function kalshi<T>(path: string, params?: Record<string, string>) {
  const url = new URL(KALSHI_BASE + path)
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "natural-markets-bot/1.0",
      ...kalshiAuthHeaders("GET", url),
    } as HeadersInit,
  })
  if (!response.ok) {
    throw new Error(`Kalshi ${path} failed: ${response.status}`)
  }
  return (await response.json()) as T
}

export function hasKalshiAuth() {
  return Boolean(config.kalshiApiKeyId() && kalshiPrivateKey())
}

export async function getExchangeStatus() {
  return kalshi<{ trading_active?: boolean; exchange_active?: boolean }>("/exchange/status")
}

export async function getBalance() {
  return kalshi<Record<string, unknown>>("/portfolio/balance")
}

export async function getMarket(ticker: string) {
  const data = await kalshi<{ market: KalshiMarket }>(
    `/markets/${encodeURIComponent(ticker)}`,
  )
  return data.market
}

export async function getAllSeries() {
  if (seriesCache && Date.now() - seriesCache.at < 60 * 60 * 1000) {
    return seriesCache.series
  }
  const series: Series[] = []
  let cursor: string | undefined
  for (let i = 0; i < 20; i += 1) {
    const page = await kalshi<{ series: Series[]; cursor?: string }>("/series", {
      limit: "200",
      ...(cursor ? { cursor } : {}),
    })
    series.push(...(page.series ?? []))
    cursor = page.cursor
    if (!cursor) break
  }
  seriesCache = { at: Date.now(), series }
  return series
}

function words(text: string) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1),
  )
}

const SPORT_BY_SERIES: [RegExp, string][] = [
  [/KXWNBA/, "WNBA"],
  [/KXNBA/, "NBA"],
  [/KXMLB/, "MLB"],
  [/KXNFL/, "NFL"],
  [/KXNCAAF|KXCFB/, "College Football"],
  [/KXNCAAB|KXCBB/, "College Basketball"],
  [/KXNHL/, "NHL"],
  [/KXUFC/, "UFC"],
  [/KXEPL|KXUCL|KXLALIGA|KXSERIEA|KXBUNDESLIGA|KXMLS|KXSOCCER/, "Soccer"],
  [/KXATP|KXWTA|KXTENNIS/, "Tennis"],
]

function sportOf(seriesTicker?: string, ticker?: string) {
  const hay = `${seriesTicker || ""} ${ticker || ""}`.toUpperCase()
  for (const [pattern, sport] of SPORT_BY_SERIES) {
    if (pattern.test(hay)) return sport
  }
  return null
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
}

// Event tickers embed the start date (and usually time) in US Eastern, e.g.
// KXMLBGAME-26AUG221610WSHMIA -> Aug 22 2026, 4:10 PM ET. Some series omit
// the time (KXWNBAGAME-26AUG22INDNY). close_time is padded days past the
// game, so the ticker is the real schedule.
function parseEventStart(eventTicker?: string) {
  const match = eventTicker
    ?.toUpperCase()
    .match(/-(\d{2})([A-Z]{3})(\d{2})(?:(\d{2})(\d{2}))?/)
  if (!match) return null
  const month = MONTHS[match[2]]
  if (month == null) return null
  const year = 2000 + Number(match[1])
  const day = Number(match[3])
  if (day < 1 || day > 31) return null
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(year, month, day)).getUTCDay()
  ]
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month]
  const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const datePart = `${weekday} ${monthName} ${day}`
  const hour = match[4] != null ? Number(match[4]) : null
  const minute = match[5] != null ? Number(match[5]) : 0
  if (hour == null || hour > 23 || minute > 59) {
    return { dateKey, label: `${datePart} (time TBD)` }
  }
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  const ampm = hour < 12 ? "AM" : "PM"
  return {
    dateKey,
    label: `${datePart}, ${h12}:${String(minute).padStart(2, "0")} ${ampm} ET`,
  }
}

function dateKeyET(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function midYesPrice(market: KalshiMarket) {
  const bid = Number(market.yes_bid_dollars ?? 0)
  const ask = Number(market.yes_ask_dollars ?? 0)
  const last = Number(market.last_price_dollars ?? 0)
  if (bid > 0 && ask > 0) return (bid + ask) / 2
  if (ask > 0) return ask
  if (bid > 0) return bid
  if (last > 0) return last
  return 0.5
}

export function formatMarket(market: KalshiMarket) {
  const yes = midYesPrice(market)
  const start = parseEventStart(market.event_ticker)
  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    title: market.event_title || market.title || market.yes_sub_title || market.ticker,
    yesSubtitle: market.yes_sub_title || "Yes",
    noSubtitle: market.no_sub_title || "No",
    yesPrice: yes,
    yesBid: Number(market.yes_bid_dollars ?? 0),
    yesAsk: Number(market.yes_ask_dollars ?? 0),
    status: market.status,
    result: market.result || "",
    closeTime: market.close_time,
    rules: market.rules_primary,
    sport: sportOf(market.series_ticker, market.ticker),
    startLabel: start?.label ?? null,
    startDateKey: start?.dateKey ?? null,
    volume24h: Math.round(Number(market.volume_24h_fp ?? 0)),
  }
}

const MAJOR_GAME_SERIES = [
  { ticker: "KXMLBGAME", title: "Pro Baseball Game" },
  { ticker: "KXWNBAGAME", title: "Women's Pro Basketball Game" },
  { ticker: "KXNBAGAME", title: "Pro Basketball Game" },
  { ticker: "KXNFLGAME", title: "Pro Football Game" },
  { ticker: "KXNCAAFGAME", title: "College Football Game" },
  { ticker: "KXNHLGAME", title: "Pro Hockey Game" },
]

// Dumb data fetcher. Scans the major game series plus any series whose name
// shares words with the query, ranks markets by word overlap and 24h volume,
// and returns them. The LLM writes the query and reads the results.
export async function searchMarkets(query: string, limit = 6) {
  const queryWords = words(query)
  const series = await getAllSeries()

  const scored = series
    .map((item) => {
      const seriesWords = words(`${item.ticker} ${item.title}`)
      let score = 0
      for (const word of queryWords) {
        if (seriesWords.has(word)) score += 1
      }
      return { item, score }
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((row) => row.item)

  const toScan = [...MAJOR_GAME_SERIES, ...scored].filter(
    (item, index, all) => all.findIndex((other) => other.ticker === item.ticker) === index,
  )

  const events: KalshiEvent[] = []
  await Promise.all(
    toScan.map(async (item) => {
      try {
        const page = await kalshi<{ events: KalshiEvent[] }>("/events", {
          series_ticker: item.ticker,
          status: "open",
          limit: "30",
          with_nested_markets: "true",
        })
        events.push(...(page.events ?? []))
      } catch {
        // Keep searching other series.
      }
    }),
  )

  const todayKey = dateKeyET(new Date())
  const markets: KalshiMarket[] = []

  for (const event of events) {
    for (const market of event.markets ?? []) {
      markets.push({
        ...market,
        event_title: event.title,
        series_ticker: event.series_ticker,
      })
    }
  }

  const ranked = markets
    .filter((market) => market.status === "active")
    .map((market) => {
      const marketWords = words(
        `${market.event_title} ${market.title} ${market.yes_sub_title} ${market.no_sub_title}`,
      )
      const startKey = parseEventStart(market.event_ticker)?.dateKey
      let score = 0
      for (const word of queryWords) {
        if (marketWords.has(word)) score += 5
      }
      // 24h volume separates games people care about from dead markets.
      const volume = Number(market.volume_24h_fp ?? 0)
      if (volume > 0) score += Math.min(4, Math.log10(1 + volume))
      if (startKey && startKey < todayKey) score -= 8
      return { market, score }
    })
    .sort((a, b) => b.score - a.score)

  // Skip effectively-decided markets (99¢/1¢) and cap markets per event.
  // Game events hold one mirror market per team, so one covers the matchup;
  // other events (multi-outcome, spreads) show their top few options.
  const perEvent = new Map<string, number>()
  const presentable = ranked.filter((row) => {
    const mid = midYesPrice(row.market)
    if (mid >= 0.97 || mid <= 0.03) return false
    const eventKey = row.market.event_ticker || row.market.ticker
    const cap = row.market.series_ticker?.endsWith("GAME") ? 1 : 3
    const count = perEvent.get(eventKey) ?? 0
    if (count >= cap) return false
    perEvent.set(eventKey, count + 1)
    return true
  })

  return {
    query,
    todayET: todayKey,
    markets: presentable.slice(0, limit).map((row) => formatMarket(row.market)),
  }
}

export function isResolved(market: KalshiMarket) {
  const result = market.result
  const status = market.status
  return (
    (status === "determined" || status === "finalized") &&
    (result === "yes" || result === "no")
  )
}

export type Side = "yes" | "no"

export function dollars(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  })
}

export function parseDollars(input: string) {
  const cleaned = input.replace(/[$,]/g, "").trim()
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100)
}

export function clampPrice(price: number) {
  return Math.min(0.99, Math.max(0.01, price))
}

export function priceToCents(price: number) {
  return Math.round(clampPrice(price) * 100)
}

export function centsToPrice(cents: number) {
  return clampPrice(cents / 100)
}

export function parseAmericanOdds(input: string) {
  const match = input.trim().match(/^([+-]?)(\d{2,4})$/)
  if (!match) return null
  const sign = match[1] === "-" ? -1 : 1
  const n = Number(match[2]) * sign
  if (n === 0) return null
  if (n > 0) return clampPrice(100 / (n + 100))
  return clampPrice(-n / (-n + 100))
}

export function toAmerican(price: number) {
  const p = clampPrice(price)
  if (p >= 0.5) return `${Math.round((-100 * p) / (1 - p))}`
  return `+${Math.round((100 * (1 - p)) / p)}`
}

export function matchStakes(input: {
  proposerSide: Side
  proposerStakeCents: number
  yesPrice: number
}) {
  const p = clampPrice(input.yesPrice)
  const stake = input.proposerStakeCents
  if (input.proposerSide === "yes") {
    const yesStakeCents = stake
    const noStakeCents = Math.max(1, Math.round((stake * (1 - p)) / p))
    return { yesStakeCents, noStakeCents, potCents: yesStakeCents + noStakeCents }
  }
  const noStakeCents = stake
  const yesStakeCents = Math.max(1, Math.round((stake * p) / (1 - p)) )
  return { yesStakeCents, noStakeCents, potCents: yesStakeCents + noStakeCents }
}

export function payoutAmount(input: {
  result: Side
  yesStakeCents: number
  noStakeCents: number
}) {
  return input.result === "yes" ? input.noStakeCents : input.yesStakeCents
}

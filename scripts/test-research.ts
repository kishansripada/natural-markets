import "dotenv/config"
import { researchBetOutcome } from "@/lib/research"
import type { Bet } from "@/lib/db"

const bet = {
  id: "bet_test",
  marketTitle: "Sydney is above 70°F right now",
  resolutionCriteria:
    "The current temperature at Sydney Observatory Hill (Sydney, Australia) per the Australian Bureau of Meteorology or another major weather service exceeds 70°F (21.1°C) at resolution time.",
  createdAt: new Date().toISOString(),
} as Bet

const verdict = await researchBetOutcome(bet)
console.log(JSON.stringify(verdict, null, 2))

"use server"

import { linkUserToParty, listUsers } from "@/lib/db"
import { getOrCreateInviteLink, syncCustomersToSlackUsers } from "@/lib/natural"
import { resolveLiveBets } from "@/lib/resolve"

export async function createInviteAction() {
  await getOrCreateInviteLink()
}

export async function syncCustomersAction() {
  await syncCustomersToSlackUsers()
}

export async function linkUserAction(formData: FormData) {
  const slackUserId = String(formData.get("slackUserId") || "")
  const naturalPartyId = String(formData.get("naturalPartyId") || "")
  if (!slackUserId || !naturalPartyId.startsWith("pty_")) {
    throw new Error("Pick a Slack user and a pty_ party id")
  }
  const user = (await listUsers()).find(
    (item) => item.slackUserId === slackUserId,
  )
  await linkUserToParty({
    slackUserId,
    naturalPartyId,
    naturalName: user?.naturalName ?? null,
  })
}

export async function resolveNowAction() {
  await resolveLiveBets()
}

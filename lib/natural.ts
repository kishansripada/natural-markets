import Natural from "@naturalpay/sdk"
import { config } from "@/lib/config"
import {
  getLatestInviteLink,
  linkUserByEmail,
  linkUserToParty,
  listUsers,
  saveInviteLink,
} from "@/lib/db"

const CUSTOMER_PERMISSIONS = [
  "payments.create",
  "payments.read",
  "wallets.read",
  "party.read",
] as const

function client(instanceId?: string) {
  return new Natural({
    token: config.naturalApiKey(),
    instanceId,
  })
}

// The developer's own account. Delegation-to-self doesn't work on Natural,
// so this email is treated as already connected and maps to the operator's
// own party behind the scenes.
export const OPERATOR_EMAIL = "kishansripada@gmail.com"

let operatorPartyId: string | null = null

export async function getOperatorPartyId() {
  if (operatorPartyId) return operatorPartyId
  const me = await client().parties.get()
  operatorPartyId = me.data.id
  return operatorPartyId
}

export function isOperatorEmail(email: string) {
  return email.trim().toLowerCase() === OPERATOR_EMAIL
}

export async function listNaturalCustomers() {
  const page = await client().customers.list()
  return page.data.map((customer) => ({
    partyId: customer.id,
    name: customer.attributes.name,
    email: customer.attributes.email,
  }))
}

export async function syncCustomersToSlackUsers() {
  const customers = await listNaturalCustomers()
  const linked = []
  for (const customer of customers) {
    if (!customer.email) continue
    const user = await linkUserByEmail(
      customer.email,
      customer.partyId,
      customer.name,
    )
    if (user) linked.push(user)
  }
  // The operator never appears in customers.list() — they ARE the account.
  // Link them by their stored email so they're never asked to connect.
  for (const user of await listUsers()) {
    if (
      !user.naturalPartyId &&
      user.slackEmail &&
      isOperatorEmail(user.slackEmail)
    ) {
      await linkUserToParty({
        slackUserId: user.slackUserId,
        naturalPartyId: await getOperatorPartyId(),
      })
      linked.push(user)
    }
  }
  return { customers, linked }
}

export async function getOrCreateInviteLink() {
  const existing = await getLatestInviteLink()
  if (existing) return existing
  const created = await client().invitationLinks.create({
    name: "Slack Natural Markets",
    proposedAgents: [
      {
        agentId: config.naturalAgentId(),
        permissions: [...CUSTOMER_PERMISSIONS],
        limits: { perTransaction: config.naturalPerTxLimitCents() },
      },
    ],
    tags: { channel: "slack" },
  })
  const link = {
    id: created.data.id,
    url: created.data.attributes.url,
    name: created.data.attributes.name,
  }
  await saveInviteLink(link)
  return link
}

export async function inviteCustomerByEmail(email: string) {
  const invitations = await client().customers.createInvitations({
    recipients: [{ type: "email", value: email }],
    agents: [
      {
        agentId: config.naturalAgentId(),
        permissions: [...CUSTOMER_PERMISSIONS],
        limits: { perTransaction: config.naturalPerTxLimitCents() },
      },
    ],
    message:
      "Connect Natural Markets so it can settle Slack bets from your wallet when Kalshi resolves.",
    tags: { channel: "slack" },
  })
  const first = invitations.data[0]
  return {
    id: first.id,
    url: first.attributes.url,
    email: first.attributes.email,
  }
}

export async function payBetweenCustomers(input: {
  fromPartyId: string
  toPartyId: string
  amountCents: number
  description: string
  betId: string
}) {
  const payment = await client(`bet-${input.betId}`).payments.create({
    amount: input.amountCents,
    currency: "USD",
    counterparty: { type: "party_id", value: input.toPartyId },
    customerPartyId: input.fromPartyId,
    // Natural rejects payment descriptions over 80 chars (422 invalid_value).
    description: input.description.slice(0, 80),
    idempotencyKey: `bet-payout-${input.betId}`,
    tags: { bet_id: input.betId },
  })
  return payment.data.id
}

import { existsSync, readFileSync } from "node:fs"
import { Pool } from "pg"
import { config } from "@/lib/config"
import type { Side } from "@/lib/money"

export type ProposalStatus =
  | "open"
  | "pending"
  | "pending_connect"
  | "live"
  | "cancelled"
  | "expired"

export type BetStatus = "live" | "settled" | "void" | "payout_failed"

export type SlackUser = {
  slackUserId: string
  slackTeamId: string
  slackName: string | null
  slackEmail: string | null
  naturalPartyId: string | null
  naturalName: string | null
  connectedAt: string | null
  createdAt: string
}

export type Proposal = {
  id: string
  status: ProposalStatus
  channelId: string
  teamId: string
  messageTs: string | null
  threadTs: string | null
  proposerSlackId: string
  counterpartySlackId: string | null
  proposerAccepted: number
  counterpartyAccepted: number
  kalshiTicker: string | null
  kalshiEventTicker: string | null
  marketTitle: string
  yesSubtitle: string | null
  noSubtitle: string | null
  proposerSide: Side
  yesPriceCents: number
  oddsSource: "kalshi" | "custom"
  proposerStakeCents: number
  counterpartyStakeCents: number
  yesStakeCents: number
  noStakeCents: number
  potCents: number
  rawQuery: string | null
  /** Custom (non-Kalshi) bets: exact statement of what makes YES true and
   * how to verify it. Null for Kalshi-backed markets. */
  resolutionCriteria?: string | null
  /** Custom bets: ISO time when the bot may start researching the answer. */
  resolveAfter?: string | null
  createdAt: string
  updatedAt: string
}

export type Bet = {
  id: string
  proposalId: string | null
  status: BetStatus
  channelId: string
  teamId: string
  messageTs: string | null
  yesSlackId: string
  noSlackId: string
  yesPartyId: string | null
  noPartyId: string | null
  kalshiTicker: string | null
  kalshiEventTicker: string | null
  marketTitle: string
  yesSubtitle: string | null
  noSubtitle: string | null
  yesPriceCents: number
  oddsSource: "kalshi" | "custom"
  yesStakeCents: number
  noStakeCents: number
  potCents: number
  kalshiResult: Side | null
  winnerSlackId: string | null
  payoutPaymentId: string | null
  payoutError: string | null
  resolvedAt: string | null
  /** Custom bets: see Proposal.resolutionCriteria / resolveAfter. */
  resolutionCriteria?: string | null
  resolveAfter?: string | null
  /** Custom bets: evidence summary from the research pass that settled it. */
  resolutionNote?: string | null
  createdAt: string
  updatedAt: string
}

export type InviteLink = {
  id: string
  url: string
  name: string | null
  createdAt: string
}

// Entities live in Postgres as jsonb payloads keyed by id — durable across
// deploys and shared by the web and bot processes.

let pool: Pool | null = null
let ready: Promise<void> | null = null

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error("DATABASE_URL is not set")
    pool = new Pool({ connectionString: url, max: 5 })
  }
  return pool
}

async function ensureReady() {
  if (!ready) ready = init()
  return ready
}

async function init() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (slack_user_id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals (id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS bets (id text PRIMARY KEY, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS invite_links (id text PRIMARY KEY, data jsonb NOT NULL);
  `)
  await seedFromJsonFile()
}

/** One-time migration from the old JSON-file store, if one exists. */
async function seedFromJsonFile() {
  const db = getPool()
  const { rows } = await db.query("SELECT 1 FROM users LIMIT 1")
  if (rows.length > 0) return
  const file = config.storePath()
  if (!existsSync(file)) return
  let store: {
    users?: SlackUser[]
    proposals?: Proposal[]
    bets?: Bet[]
    inviteLinks?: InviteLink[]
  }
  try {
    store = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return
  }
  for (const user of store.users ?? []) {
    await db.query(
      "INSERT INTO users (slack_user_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [user.slackUserId, user],
    )
  }
  for (const proposal of store.proposals ?? []) {
    await db.query(
      "INSERT INTO proposals (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [proposal.id, proposal],
    )
  }
  for (const bet of store.bets ?? []) {
    await db.query(
      "INSERT INTO bets (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [bet.id, bet],
    )
  }
  for (const link of store.inviteLinks ?? []) {
    await db.query(
      "INSERT INTO invite_links (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [link.id, link],
    )
  }
  console.log("[db] migrated JSON store into Postgres:", {
    users: store.users?.length ?? 0,
    proposals: store.proposals?.length ?? 0,
    bets: store.bets?.length ?? 0,
  })
}

async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  await ensureReady()
  const { rows } = await getPool().query(sql, params)
  return rows.map((row: { data: T }) => row.data)
}

function now() {
  return new Date().toISOString()
}

export async function upsertUser(input: {
  slackUserId: string
  slackTeamId: string
  slackName?: string | null
  slackEmail?: string | null
}): Promise<SlackUser> {
  const existing = await getUser(input.slackUserId)
  if (!existing) {
    const created: SlackUser = {
      slackUserId: input.slackUserId,
      slackTeamId: input.slackTeamId,
      slackName: input.slackName ?? null,
      slackEmail: input.slackEmail ?? null,
      naturalPartyId: null,
      naturalName: null,
      connectedAt: null,
      createdAt: now(),
    }
    await query(
      "INSERT INTO users (slack_user_id, data) VALUES ($1, $2) ON CONFLICT (slack_user_id) DO NOTHING",
      [created.slackUserId, created],
    )
    return created
  }
  const updated: SlackUser = {
    ...existing,
    slackTeamId: input.slackTeamId,
    slackName: input.slackName || existing.slackName,
    slackEmail: input.slackEmail || existing.slackEmail,
  }
  await query("UPDATE users SET data = $2 WHERE slack_user_id = $1", [
    updated.slackUserId,
    updated,
  ])
  return updated
}

export async function getUser(slackUserId: string): Promise<SlackUser | null> {
  const rows = await query<SlackUser>(
    "SELECT data FROM users WHERE slack_user_id = $1",
    [slackUserId],
  )
  return rows[0] ?? null
}

export async function listUsers(): Promise<SlackUser[]> {
  return query<SlackUser>(
    "SELECT data FROM users ORDER BY data->>'createdAt' DESC",
  )
}

export async function linkUserToParty(input: {
  slackUserId: string
  naturalPartyId: string
  naturalName?: string | null
}) {
  const user = await getUser(input.slackUserId)
  if (!user) return
  const updated: SlackUser = {
    ...user,
    naturalPartyId: input.naturalPartyId,
    naturalName: input.naturalName ?? null,
    connectedAt: now(),
  }
  await query("UPDATE users SET data = $2 WHERE slack_user_id = $1", [
    updated.slackUserId,
    updated,
  ])
}

export async function linkUserByEmail(
  email: string,
  partyId: string,
  name?: string | null,
): Promise<SlackUser | null> {
  const rows = await query<SlackUser>(
    "SELECT data FROM users WHERE lower(data->>'slackEmail') = lower($1)",
    [email],
  )
  const user = rows[0]
  if (!user) return null
  const updated: SlackUser = {
    ...user,
    naturalPartyId: partyId,
    naturalName: name ?? null,
    connectedAt: now(),
  }
  await query("UPDATE users SET data = $2 WHERE slack_user_id = $1", [
    updated.slackUserId,
    updated,
  ])
  return updated
}

export async function saveInviteLink(input: {
  id: string
  url: string
  name?: string
}) {
  const link: InviteLink = {
    id: input.id,
    url: input.url,
    name: input.name ?? null,
    createdAt: now(),
  }
  await query(
    "INSERT INTO invite_links (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = $2",
    [link.id, link],
  )
}

export async function getLatestInviteLink(): Promise<InviteLink | null> {
  const rows = await query<InviteLink>(
    "SELECT data FROM invite_links ORDER BY data->>'createdAt' DESC LIMIT 1",
  )
  return rows[0] ?? null
}

export async function insertProposal(proposal: Proposal) {
  await query("INSERT INTO proposals (id, data) VALUES ($1, $2)", [
    proposal.id,
    proposal,
  ])
}

export async function updateProposal(
  id: string,
  patch: Partial<Proposal>,
): Promise<Proposal | null> {
  const existing = await getProposal(id)
  if (!existing) return null
  const updated: Proposal = { ...existing, ...patch, updatedAt: now() }
  await query("UPDATE proposals SET data = $2 WHERE id = $1", [id, updated])
  return updated
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const rows = await query<Proposal>("SELECT data FROM proposals WHERE id = $1", [
    id,
  ])
  return rows[0] ?? null
}

export async function getProposalByMessage(
  channelId: string,
  messageTs: string,
): Promise<Proposal | null> {
  const rows = await query<Proposal>(
    `SELECT data FROM proposals
     WHERE data->>'channelId' = $1
       AND (data->>'messageTs' = $2 OR data->>'threadTs' = $2)
     ORDER BY data->>'createdAt' DESC LIMIT 1`,
    [channelId, messageTs],
  )
  return rows[0] ?? null
}

export async function getLedger() {
  const [users, proposals, bets] = await Promise.all([
    listUsers(),
    listProposals(),
    listBets(),
  ])
  return { users, proposals, bets }
}

export async function listProposals(
  status?: ProposalStatus,
): Promise<Proposal[]> {
  if (status) {
    return query<Proposal>(
      "SELECT data FROM proposals WHERE data->>'status' = $1 ORDER BY data->>'createdAt' DESC",
      [status],
    )
  }
  return query<Proposal>(
    "SELECT data FROM proposals ORDER BY data->>'createdAt' DESC",
  )
}

export async function insertBet(bet: Bet) {
  await query("INSERT INTO bets (id, data) VALUES ($1, $2)", [bet.id, bet])
}

export async function updateBet(
  id: string,
  patch: Partial<Bet>,
): Promise<Bet | null> {
  const existing = await getBet(id)
  if (!existing) return null
  const updated: Bet = { ...existing, ...patch, updatedAt: now() }
  await query("UPDATE bets SET data = $2 WHERE id = $1", [id, updated])
  return updated
}

export async function getBet(id: string): Promise<Bet | null> {
  const rows = await query<Bet>("SELECT data FROM bets WHERE id = $1", [id])
  return rows[0] ?? null
}

export async function listBets(status?: BetStatus): Promise<Bet[]> {
  if (status) {
    return query<Bet>(
      "SELECT data FROM bets WHERE data->>'status' = $1 ORDER BY data->>'createdAt' DESC",
      [status],
    )
  }
  return query<Bet>("SELECT data FROM bets ORDER BY data->>'createdAt' DESC")
}

export async function listUserBets(slackUserId: string): Promise<Bet[]> {
  return query<Bet>(
    `SELECT data FROM bets
     WHERE data->>'yesSlackId' = $1 OR data->>'noSlackId' = $1
     ORDER BY data->>'createdAt' DESC`,
    [slackUserId],
  )
}

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
}

export function timestamp() {
  return now()
}

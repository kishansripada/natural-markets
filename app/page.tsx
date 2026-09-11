import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  createInviteAction,
  linkUserAction,
  resolveNowAction,
  syncCustomersAction,
} from "@/app/actions"
import { listBets, listProposals, listUsers } from "@/lib/db"
import { dollars } from "@/lib/money"
import { listNaturalCustomers } from "@/lib/natural"

// The dashboard reads Postgres, which only exists at runtime — never at build.
export const dynamic = "force-dynamic"

function statusBadge(status: string) {
  const variant =
    status === "live" || status === "settled"
      ? "default"
      : status === "payout_failed" || status === "cancelled"
        ? "destructive"
        : "secondary"
  return <Badge variant={variant}>{status}</Badge>
}

export default async function Page() {
  const users = await listUsers()
  const proposals = await listProposals()
  const bets = await listBets()
  let customers: Awaited<ReturnType<typeof listNaturalCustomers>> = []
  try {
    customers = await listNaturalCustomers()
  } catch {
    customers = []
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col gap-8 p-6">
      <div>
        <p className="text-sm text-muted-foreground">@kishansripada-marketmaker</p>
        <h1 className="font-heading text-3xl">Natural Markets</h1>
        <p className="max-w-2xl text-muted-foreground">
          Slack proposes a side. Someone else claims it. After both confirm, the
          bet goes live. When Kalshi resolves, the bot pays the winner with
          Natural <code>payments.create</code>.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Live bets</CardTitle>
            <CardDescription>Waiting on Kalshi</CardDescription>
          </CardHeader>
          <CardContent className="text-3xl font-medium">
            {bets.filter((bet) => bet.status === "live").length}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Open proposals</CardTitle>
            <CardDescription>Need the other side</CardDescription>
          </CardHeader>
          <CardContent className="text-3xl font-medium">
            {proposals.filter((proposal) => proposal.status === "open").length}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Connected wallets</CardTitle>
            <CardDescription>Slack users with a Natural party</CardDescription>
          </CardHeader>
          <CardContent className="text-3xl font-medium">
            {users.filter((user) => user.naturalPartyId).length}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="bets">
        <TabsList>
          <TabsTrigger value="bets">Bets</TabsTrigger>
          <TabsTrigger value="proposals">Proposals</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>
        <TabsContent value="bets">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>Ledger</CardTitle>
                <CardDescription>Stored in Postgres</CardDescription>
              </div>
              <form action={resolveNowAction}>
                <Button type="submit" variant="outline">
                  Poll Kalshi now
                </Button>
              </form>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Pot</TableHead>
                    <TableHead>Kalshi</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bets.map((bet) => (
                    <TableRow key={bet.id}>
                      <TableCell>{bet.marketTitle}</TableCell>
                      <TableCell>{statusBadge(bet.status)}</TableCell>
                      <TableCell>{dollars(bet.potCents)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {bet.kalshiTicker}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="proposals">
          <Card>
            <CardHeader>
              <CardTitle>Proposals</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Market</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Stake</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proposals.map((proposal) => (
                    <TableRow key={proposal.id}>
                      <TableCell>{proposal.marketTitle}</TableCell>
                      <TableCell>{statusBadge(proposal.status)}</TableCell>
                      <TableCell>{proposal.proposerSide}</TableCell>
                      <TableCell>{dollars(proposal.proposerStakeCents)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="people">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Natural Connect</CardTitle>
                <CardDescription>
                  People delegate the market maker agent, then Slack can map them
                  by email.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <form action={createInviteAction}>
                  <Button type="submit">Create or reuse invite link</Button>
                </form>
                <form action={syncCustomersAction}>
                  <Button type="submit" variant="outline">
                    Sync Natural customers
                  </Button>
                </form>
                <div className="text-sm text-muted-foreground">
                  {customers.length
                    ? `${customers.length} customer${customers.length === 1 ? "" : "s"} on Natural.`
                    : "No customers have delegated yet."}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Link a Slack user</CardTitle>
                <CardDescription>
                  If email matching misses, paste their pty_ id.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form action={linkUserAction} className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="slackUserId">Slack user id</Label>
                    <Input
                      id="slackUserId"
                      name="slackUserId"
                      placeholder="U012345"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="naturalPartyId">Natural party id</Label>
                    <Input
                      id="naturalPartyId"
                      name="naturalPartyId"
                      placeholder="pty_..."
                    />
                  </div>
                  <Button type="submit">Save mapping</Button>
                </form>
              </CardContent>
            </Card>
          </div>
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Slack users</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Natural email</TableHead>
                    <TableHead>Party</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => (
                    <TableRow key={user.slackUserId}>
                      <TableCell>{user.slackName || user.slackUserId}</TableCell>
                      <TableCell>{user.slackEmail || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {user.naturalPartyId || "not connected"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  )
}

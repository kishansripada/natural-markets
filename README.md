# Natural Markets

A Slack bot that answers Kalshi questions and facilitates peer-to-peer bets. People in Slack take opposite sides. After both confirm, the bot stores a live market and polls Kalshi. When that market resolves, it pays the winner with Natural `payments.create` from the loser's delegated wallet.

Bets don't need a Kalshi market. Anything the bot can verify by research works too — "is it above 70°F in Sydney right now", "does it rain in SF by Friday". Custom bets default to even 50/50 odds unless someone names odds, follow the same take-the-other-side + both-confirm flow, and the bot refuses to reveal the answer while the bet is open. A separate research pass (OpenAI web search, outside the chat) settles it after the resolve time and announces the evidence with the payout.

It uses:

- [@slack/bolt](https://github.com/slackapi/bolt-js) for Socket Mode, @mentions, reactions, and buttons
- [jsx-slack](https://github.com/yhatt/jsx-slack) for Block Kit cards
- [slackify-markdown](https://github.com/jsarafajr/slackify-markdown) for LLM replies
- Kalshi's public market-data API (no Kalshi key)
- `@naturalpay/sdk` for Connect invites and payouts

There is no database. The whole book is one JSON file at `data/markets.json`: every proposal, live bet, settlement, and Slack-to-Natural mapping. Nothing is discarded. Each Slack turn loads that full history so the agent can answer across the long horizon — what is open, what already settled, who is on which side.

## How a market works

1. Someone @mentions the bot: `I want the Celtics side tonight for $25`.
2. The bot looks up the matching Kalshi market and posts an open-market card using Kalshi's current mid as the default odds. People can also name custom American odds like `+120`.
3. Nothing happens until someone else @mentions the bot to take the other side, reacts `:white_check_mark:`, or clicks **Take the other side**. The bot never talks unless it is @mentioned (except button, reaction, and settlement cards).
4. Both people confirm. If either wallet is missing, the bot sends a Natural Connect invite.
5. The bet goes live. A poller checks Kalshi (`determined` / `finalized` + `yes`/`no`).
6. The loser pays the winner through Natural: `customerPartyId` is the loser, `counterparty.party_id` is the winner.

Kalshi is the resolution source for Kalshi-backed bets. Custom odds only change the stake match, not who wins. For custom bets the resolver runs `lib/research.ts` — a neutral web-search pass that returns yes/no with an evidence note, or "unresolved" with a time to check back.

## Setup

1. Create a Slack app from `slack-manifest.json` (Create New App → From a manifest).
2. Enable Socket Mode and create an app-level token with `connections:write`.
3. Install the app to your workspace and invite the bot to a channel.
4. Copy `.env.example` to `.env.local` and fill in Slack tokens. The Natural agent key for `@kishansripada-marketmaker` goes in `NATURAL_API_KEY`.
5. Ask each bettor to @mention the bot with the email they want to use on Natural, then approve the market maker agent. The bot never uses their Slack profile email.

```bash
npm install
npm run bot
```

Optional operator UI:

```bash
npm run dev
```

`OPENAI_API_KEY` is optional. Without it, the bot still parses natural-language bets, line questions, and connect requests.

## Notes

- Rotate the Natural agent key if it has been pasted into chat.
- This is peer-to-peer payment facilitation, not a Kalshi brokerage account. Check local law before running it with real money.
- Right now there is no NBA game tonight (22 Aug 2026). Asking for the Celtics spread will show the next Boston market Kalshi has listed.

# Discord Manager

Let an AI assistant run your Discord server day for you. Discord Manager is a headless, self-hosted product: your own Discord bot ingests your server into a local append-only store, and an [MCP](https://modelcontextprotocol.io) server exposes it to the AI assistant you already use. There is no web UI — you catch up, triage mentions, manage bookmarks, and post replies by talking.

> "Catch me up on #engineering since yesterday, bookmark anything that needs me, and answer the deploy question in the thread."

Each person runs their own bot and their own local stack. Nothing is shared, nothing leaves your machine but the Discord API calls your own bot makes.

## What you get

- **Catch-up digests** — everything posted since a moment in time, across the server or in one channel, each message with a jump link. Long stretches come back 200 messages at a time, so your assistant can walk a busy week in order.
- **Mention triage** — the messages that pinged you, exactly as Discord counts a ping, ready for an assistant to sort by what actually needs you.
- **Bookmarks without Nitro** — react to any message with 🔖 and your bot records a bookmark; remove the reaction and it's gone. Your assistant can also bookmark by message link, resolve, and snooze — privately, with no reaction anyone can see. Only *your* reactions count, so a whole team of bots coexists in one server without crosstalk.
- **Bookmarks that know why they're there** — every bookmark is filed under a reason you manage, so *"what am I on the hook to answer?"* is a different question from *"what should I read on the train?"*. A 🔖 reaction can't carry intent, so those land in your *Inbox* for your assistant to sort.
- **Draft and send** — messages posted to any channel as your bot, optionally as a reply, with a status trail for every send. When a send comes back refused, your assistant can retry it as a linked second attempt, and the retry is refused outright unless the first one provably never reached the channel — so a message you asked for once can never turn up twice.
- **Ingestion health** — whether the bot is still receiving from Discord and how far its history backfills have got, as plain readings with a concrete next action.

Everything is stored locally in SQLite as an append-only event history: edits are revisions, deletions are events, and nothing is ever erased — a bookmarked message survives the author's edit.

## Setup

You'll need [Node.js](https://nodejs.org) 22.12+ and [pnpm](https://pnpm.io) 10.

### 1. Create your Discord app

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Name it after yourself — this bot acts for you (e.g. "Dana's Manager").
2. In **Bot**, click **Reset Token** and copy the token — you'll put it in `.env` in a moment. Keep it secret; it *is* your bot.
3. Still in **Bot**, under **Privileged Gateway Intents**, enable **Message Content Intent**. Without it Discord hands your bot empty messages.

### 2. Invite the bot to your server

In **OAuth2**, copy your **Client ID**, put it into this URL, open it, and pick your server:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=274877975552
```

`274877975552` is exactly View Channels + Send Messages + Send Messages in Threads + Read Message History — everything the product does, nothing it doesn't. You'll need to be a server admin, or ask one.

### 3. Configure

```bash
git clone https://github.com/seasonedcc/discord-manager.git
cd discord-manager
pnpm install
cp .env.example .env
```

On Linux, `pnpm install` may have to build `better-sqlite3` from source when no prebuilt binary matches your Node version — install `python3` and your distribution's build tools (`build-essential` on Debian and Ubuntu) first if the install stops there.

Fill in `.env` — the file explains where each value comes from: your bot token, your own Discord user id (so only *your* 🔖 reactions become bookmarks), and the server id.

Then create the local store:

```bash
pnpm run db:migrate
```

### 4. Start ingesting

```bash
pnpm run ingest
```

This is the long-running daemon: it connects to Discord's gateway, records everything as it happens, and backfills the history it missed while it was away — on startup and again after every reconnect. Threads Discord has archived get one last backfill each, so nothing said just before they went quiet is lost, and then they stop costing a request on every reconnect; post in one and it comes straight back. Keep it running however you keep things running (a terminal tab is fine to start).

### 5. Wire up your assistant

The repo ships a [`.mcp.json`](.mcp.json) that wires the MCP server the way an assistant spawns it. With [Claude Code](https://claude.com/claude-code), opening the repo is enough — it picks up `.mcp.json` and asks you to approve the server the first time; approve it and it starts per session from then on. For any other MCP client, point it at:

```bash
pnpm run mcp
```

If your client cannot find `pnpm` — GUI apps often start without your shell's PATH — put the absolute path in `.mcp.json` instead (`which pnpm` tells you where it lives), and give it the repo directory as the working directory.

Then just talk: *"What did I miss since this morning?"* — *"Bookmark that as something to answer later."* — *"Sort my bookmark inbox."* — *"Reply that we'll ship it Thursday."*

## Try it before inviting a bot

Want to feel the product before touching the Developer Portal? Seed a demo store and point your assistant at it:

```bash
pnpm install
cp .env.example .env    # fill the three Discord values with anything, e.g. "demo"
pnpm run db:migrate
pnpm run db:seed:dev
```

The seed only ever runs against a freshly created, empty database, and sending will fail with demo credentials — everything that reads works. It leaves one refused send behind so you can see `messages_send_status` offer a retry.

## The tools

| Tool | What you get |
| --- | --- |
| `channels_list` | The channels the bot can see, with the name each one carries now, plus its topic, category and position when it has them — and for threads, whether Discord has archived them, archived ones last |
| `activity_since` | Whether the store recorded anything after an instant — counts and newest timestamps for new messages, mentions of you, and bookmark additions, on the store's own clock, with no content |
| `messages_catch_up` | Everything posted since a moment in time, across the server or in one channel, 200 at a time |
| `mentions_list` | The messages that pinged you since a moment in time — someone naming you, plus replies to you the sender left the ping on |
| `bookmarks_add` | A bookmark from a Discord message link, filed under the reason you pick |
| `bookmarks_list` | The bookmarks still waiting on you, each with its reason, snoozed ones and single-reason views on request |
| `bookmarks_resolve` | A bookmark cleared, leaving any reaction in Discord untouched |
| `bookmarks_snooze` | A bookmark hidden until the moment you pick |
| `bookmarks_set_reason` | A bookmark filed under a different reason — how an unsorted 🔖 capture leaves the Inbox |
| `bookmark_reasons_list` | The reasons you can file bookmarks under, with how many bookmarks each one holds |
| `bookmark_reasons_add` | A reason of your own, on top of the ones you started with |
| `bookmark_reasons_edit` | A reason reworded, on every bookmark already carrying it |
| `bookmark_reasons_retire` | A reason taken out of circulation, without disturbing the bookmarks that carry it |
| `messages_send` | A message posted to a channel as your bot, optionally as a reply, or as a guarded retry of an earlier send |
| `messages_send_status` | Where a send ended up — delivered, skipped, failed, still on its way, or stalled when nothing was ever recorded — whether it can be retried, and every attempt already made at it |
| `ingestion_status` | Whether the bot is receiving from Discord, and how far backfills have got |

## Good to know

- **🔖 reactions are visible to the channel**, like any reaction. When you'd rather bookmark quietly, ask your assistant to `bookmarks_add` the message link — nothing appears in Discord.
- **Every bookmark carries a reason**, so your assistant can triage by intent rather than guess. You start with six: *Answer later*, *To-do*, *Follow up*, *Read later*, *Reference*, and *Inbox*. Add, reword, and retire your own with the `bookmark_reasons_*` tools — retiring one leaves the bookmarks already carrying it untouched, still showing its name.
- **A 🔖 reaction cannot carry intent**, so captures land in *Inbox* rather than have one invented for them. Ask your assistant to sort the inbox — *"what's in my bookmark inbox?"* — and it files each one with `bookmarks_set_reason`. Inbox is the one reason you cannot reword or retire, because it is where every unsorted capture has to land.
- **One deployment, one server, one owner.** The bot only records the server you configured, and only answers to you. Teammates clone the repo and create their own app — five minutes each, no shared infrastructure.
- **This is a bot, not your account.** Automating a user account ("self-botting") violates Discord's Terms of Service and risks a ban; Discord Manager only ever acts through a bot you created, posting as itself.

## Back up your history

Your store is the only copy of everything your bot ever saw, and it is a binary SQLite file that outgrows a git host fast — GitHub warns at 50 MB per file and refuses at 100 MB, and every commit of a binary store carries the whole file again.

`pnpm run db:export` writes the store out as text you can commit:

```bash
pnpm run db:export              # writes ./data/dump
pnpm run db:export ./somewhere  # or wherever you want it
```

The dump is one `INSERT` line per row, split into 16 MiB chunk files per table. Because the store is append-only and rows come out in id order — which is the order they arrived — every chunk but the last of each table comes out byte-identical to the previous export. Git stores only what you appended, and no file ever nears the limit. `data/dump/` is the one thing under `data/` that isn't gitignored, so committing it works out of the box. Exporting is safe while `pnpm run ingest` keeps running: it opens the store read-only and reads one consistent snapshot.

A good cadence is to export and commit after any session that changed the store — a catch-up, a bookmark sweep, a day of ingestion.

Restoring goes into a fresh file:

```bash
pnpm run db:import ./data/dump   # restores into DATABASE_PATH
pnpm run db:migrate              # apply any migrations newer than the dump
```

The import refuses to run when `DATABASE_PATH` already exists, so it can never eat a store you still have. Before it says it worked it verifies the result — SQLite's integrity check, a foreign key check across every table, and the row count restored per table. If any of that fails it says what failed, leaves the file alone for you to look at, and exits non-zero.

## Development

```bash
pnpm run test:unit   # Vitest against a real throwaway SQLite store — no mocks
pnpm run test:e2e    # behavior specs driving the real MCP server over stdio
pnpm run test        # both
pnpm run lint
pnpm run tsc
```

The store is append-only — `INSERT` is the only write, and state is computed at query time. The end-to-end suite seeds through the real ingestion code with a scripted gateway feed, spawns the real MCP server, and fails if any registered tool goes unexercised. [docs/architecture.md](docs/architecture.md) has the full picture; [CLAUDE.md](CLAUDE.md) carries the working conventions if you're contributing with an AI assistant.

## License

[MIT](LICENSE) © [Seasoned](https://seasoned.cc)

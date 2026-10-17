# AGENTS.md — Rules for AI coding agents working on SelfPhoneNG

Read this file first, every time. Then read `docs/spec/00-overview.md`.
Then read ONLY the spec files your task points to.

## What this project is

A fully open source, self-hosted business phone system (PBX) with a web admin
panel, a browser softphone, voicemail, IVRs, ring groups, queues and desk-phone
provisioning: the same kind of product as 3CX. The user brings their own SIP
trunk / phone number (the reference provider is **voip.ms**).

We do **not** write a SIP stack. **Asterisk** does all SIP and audio work. We
write the software around it: database, config generator, API, web UI.

## How the spec is organized

| File | What it covers | Read it when |
|---|---|---|
| `docs/spec/00-overview.md` | Goals, architecture, tech stack, repo layout, glossary, numbering plan | Always |
| `docs/spec/01-infrastructure.md` | Docker, Asterisk image, static Asterisk config, networking, NAT, reverse proxy, env vars | Working on Docker or Asterisk base config |
| `docs/spec/02-data-model.md` | Every database table and column | Touching the DB or any feature that stores data |
| `docs/spec/03-config-generator.md` | How DB rows become Asterisk config and dialplan (the most important file) | Working on call routing or any telephony feature |
| `docs/spec/04-backend-api.md` | API server, auth, AMI client, live state, background jobs, REST endpoints, WebSocket events | Working on the backend |
| `docs/spec/05-web-ui.md` | Admin panel, user portal, browser softphone | Working on the frontend |
| `docs/spec/06-voipms.md` | voip.ms trunk setup, inbound DID handling, SMS, E911 | Working on trunks, SMS, or emergency calling |
| `docs/spec/07-provisioning.md` | Desk phone auto-provisioning (Yealink, Grandstream, Polycom) and mobile apps | Working on provisioning |
| `docs/spec/08-security-ops.md` | Security, backups, monitoring, legal requirements | Before any release, and when touching auth or networking |
| `docs/spec/09-roadmap.md` | Milestones, ordered tasks, acceptance criteria | Picking your next task |

## Hard rules

1. **Do one task at a time.** Tasks have IDs like `M3-T2` in `09-roadmap.md`.
   Do not start the next task until the current one meets every acceptance criterion.
2. **Follow the file paths in the spec exactly.** Do not invent new top-level folders.
3. **Do not add dependencies** that are not listed in `00-overview.md` §4 without
   writing the reason in `docs/decisions/NNNN-title.md` (one short paragraph).
4. **Everything must be open source.** Never add a closed-source or binary-only
   component. In particular: do NOT install Asterisk's binary `codec_opus` or `codec_g729` modules.
5. **Never hand-edit generated Asterisk files** (`/etc/asterisk/selfphoneng/*.conf`).
   Change the generator in `apps/api/src/generator/` instead.
6. **Every generator change needs a golden-file test** (see `03-config-generator.md` §12).
7. **Never log secrets** (SIP passwords, API keys, session tokens, voicemail PINs).
8. **Validate all API input with zod.** Never build SQL by string concatenation.
   Never put raw user input into dialplan text without running it through the
   sanitizers in `03-config-generator.md` §2.
9. **If the spec is unclear**, choose the simplest option that fits the spec,
   leave a comment `// TODO(spec): <question>` at that spot, and list the question
   in your final summary. Do not stop working to wait for an answer.
10. **Asterisk dialplan snippets in this spec are reference code.** They are
    believed correct for Asterisk 24 but must be proven by the tests named in
    each task. If a snippet is wrong, fix it, and update the spec file in the same commit.

## Commands (once M0 is done)

```bash
pnpm install            # install everything
pnpm dev                # api + web in watch mode (needs docker compose up -d postgres asterisk)
pnpm test               # all unit tests (vitest)
pnpm lint               # eslint + prettier check
pnpm typecheck          # tsc --noEmit in every package
pnpm db:migrate         # run drizzle migrations
docker compose up -d    # full stack
```

Before you say a task is done, `pnpm lint && pnpm typecheck && pnpm test` must all pass.

## Commit style

`<area>: <what changed>`, e.g. `generator: add ring group hunt strategy`.
One task per commit (or a short series), with the task ID in the body.

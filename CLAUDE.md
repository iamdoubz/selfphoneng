# CLAUDE.md — SelfPhoneNG Project Guide

This file tells Claude how to work on this repository. Read it fully before
making changes. It encodes hard-won conventions, security invariants, and
bugs already fixed — do not reintroduce them.

---

## MEMANTO - Your Active Memory Companion

**MEMANTO is not a passive store. It is an active companion agent that works alongside you.**
Don't treat MEMANTO like a static blob you query once and forget. It's a teammate you keep
talking to, every preference, decision, and correction flows through it. MEMANTO remembers,
recalls, and answers so you hold context across sessions, honor prior decisions, and avoid
repeating mistakes the user already corrected.

Every memory operation in this session goes through MEMANTO. There is no exception.

> **CRITICAL**: All `memanto` commands are **shell commands**. Always run them using the Bash tool.
> Never simulate, describe, or "pretend to call" them. If you cannot run the shell, say so explicitly instead of inventing memory state.

### NON-NEGOTIABLE RULES

These are not suggestions. Follow each one on every turn.

0. **Activate the `selfphoneng` agent at the start of every session, before any memory op.** Run
   `memanto agent activate selfphoneng` first thing. This machine hosts multiple projects and the
   session-start sync may activate a *different* project's agent (e.g. `gmmff`), so the
   auto-synced `MEMORY.md` can belong to the wrong project — do not trust it as selfphoneng context
   until you've activated `selfphoneng` and re-synced. Confirm with `memanto agent list` (the
   active one is marked). All `recall`/`remember`/`answer` calls read and write the *active*
   agent's store, so getting this wrong silently pollutes or mis-reads another project's memory.

---
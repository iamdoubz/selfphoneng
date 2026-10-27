# 0006 — Spam check: IPQualityScore and the FTC complaint list

Owner, 2026-10-27: show what's known about an outside caller who isn't in anyone's contacts
(14). The callers are in the US, so the providers are US ones: **IPQualityScore** (a live
lookup with a fraud score, spammer and recent-abuse flags, line type and carrier; free plan of
1,000 lookups a month) and the **FTC Do Not Call complaint data** (free, synced daily into a local
table through api.ftc.gov, so a check sends nothing out). IPQualityScore answers first when set
up; the FTC list answers when it isn't or can't. Rejected: OpenSpam (Spanish numbers;
kept for later), Hiya and Telnyx Number Reputation (contract only, or only for your own numbers),
Truecaller (no open API), CallerAPI, Nomorobo, Trestle and YouMail (no free plan, prices on
request or per query only). No package is added: both are plain HTTPS with `fetch`. IPQualityScore
is closed-source, but it's an optional outside service the admin turns on, like an SMTP server,
not a component we ship. It sends the caller's number out of the server, so it is off by default
and asks the admin to confirm (14 §8).

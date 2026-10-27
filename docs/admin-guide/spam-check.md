# Spam check

When an outside caller from the US isn't anyone's contact, SelfPhoneNG can look the number up
and show what's known about it while it rings:

- **Browser phone:** a red **Likely spam** or amber **Possible spam** badge under the caller's
  name, with a line such as "Fraud score 92 · spammer · VOIP · Austin, TX" or "Reported to the
  FTC 4 times (3 robocalls), last on Oct 20: Warranties".
- **Desk phones:** the caller's name shows as **SPAM LIKELY** or **Spam risk** (you can change
  these), if the answer comes in before the phone starts ringing (about a second).
- **Call history:** the same badge and line, for good: what was known when the call ended.

It's **information only**. Calls are never blocked, delayed or sent elsewhere, and a lookup that
fails or is slow only means nothing is shown (and one warning in the api log). Low-risk callers,
contacts, internal calls, withheld numbers and numbers outside the US show nothing.

It's off until you turn it on in **Settings → Spam check**.

## The two sources

You can use either one, or both. With both, IPQualityScore answers first, and the FTC list
answers when IPQualityScore isn't set up, fails, or has run out of lookups.

| | IPQualityScore | FTC complaint list |
|---|---|---|
| What it is | A live lookup service with a fraud score per number | Complaints people filed with the FTC about unwanted calls |
| Cost | 1,000 lookups a month free, then paid plans | Free |
| Sends your callers' numbers out | **Yes**, to IPQualityScore | No: the list is downloaded to this server |
| Likely spam | Flagged as a spammer, or fraud score 85+ | 3+ complaints in the window |
| Possible spam | Fraud score 75+, recent abuse, or risky | 1–2 complaints |

The FTC's reports aren't verified, and spammers fake real people's numbers: a number with
complaints may belong to someone whose number was faked. That's why the badge says what was
reported, not that the caller is a spammer.

## IPQualityScore

1. Sign up at <https://www.ipqualityscore.com/> and copy your API key from the account settings.
2. In **Settings → Spam check**, tick **Use IPQualityScore**, paste the key and press **Test**.
   It shows how many lookups are left this billing period.
3. Tick **Spam check on** and **Save**. You're asked to confirm that callers' numbers will be
   sent to IPQualityScore (see [Privacy](#privacy)).

Each number is looked up once and the answer kept: 14 days for possible and likely spam, 3 days
for the rest (**Keep IPQualityScore answers** changes these). Five phones ringing for the same
call cost one lookup.

**When the lookups run out**, SelfPhoneNG stops asking IPQualityScore and the dashboard says so
(**Dismiss** hides it until the next time). Checks use the FTC list meanwhile, if it's set up.
Every 6 hours it asks IPQualityScore whether lookups are back and carries on by itself. Saving a
new key carries on at once.

## FTC complaint list

1. Get a free key at <https://api.data.gov/signup/>.
2. In **Settings → Spam check**, tick **Use the FTC list**, paste the key, press **Test**, then
   **Save** (with **Spam check on**).

The first download takes the last 30 days (**Keep complaints for**) and runs for about 7 hours:
api.data.gov allows a key 1,000 requests an hour, and there are 5,000 to 15,000 complaints a day.
The tab shows how far it got. After that it fetches what's new every 24 hours (**Download again
every**); **Download now** starts one at once. If the FTC refuses the key or is down, the tab
shows why and it tries again every minute from where it stopped.

## Privacy

- With **IPQualityScore**, the number of every outside caller who isn't a contact is sent to
  IPQualityScore, a company in the US. If your privacy notice lists who you share data with, add
  it. In the EU and UK the GDPR applies: you need a lawful basis (usually legitimate interest in
  protecting staff from fraud) and a data processing agreement with IPQualityScore.
- With the **FTC list** only, nothing about your calls leaves the server.
- Only a number that's ringing one of the user's own phones is looked up: nobody can use the
  browser phone to look up numbers that never called.
- The keys are stored encrypted and never shown again; the audit log hides them.

## If nothing shows

- Is **Spam check on**, and is the caller in someone's contacts (contacts always win)?
- Check the api log for `spam check failed` (it says which source and why) or
  `FTC complaint download failed`:

  ```sh
  docker compose logs api | grep -iE 'spam|ftc'
  ```

- Desk phones only show the label when the answer is quick. A first call from a number may show
  nothing there while the browser phone shows it; the next call uses the kept answer.

# Browser checks

Dependency-free scripts that drive a headless Chromium (Edge/Chrome) over the DevTools
protocol. They need an api serving the built web UI and a fresh database.

```sh
pnpm --filter @selfphoneng/web build && mkdir -p /tmp/sp && cp -r apps/web/dist /tmp/sp/public
# fresh DB, then from /tmp/sp:
DATABASE_URL=postgres://… INITIAL_ADMIN_EMAIL=admin@example.com INITIAL_ADMIN_PASSWORD=initial-admin-pw \
  node --env-file=<repo>/.env --conditions=source <repo>/apps/api/src/index.ts
BROWSER=/usr/bin/chromium node scripts/e2e/m1-t4.mjs http://127.0.0.1:8080 admin@example.com initial-admin-pw /tmp/shots
node scripts/e2e/mobile.mjs http://127.0.0.1:8080 admin@example.com correct-horse-battery-staple /tmp/shots
```

`m1-t4.mjs` is the M1-T4 acceptance flow: forced password change, then create/edit/delete a user.

## M2 live loop (any Docker host, no host networking)

`m2-live.mjs` runs the whole chain on a private Docker network: a test Asterisk with AMI published
on `127.0.0.1:15038`, the api writing config into it, two baresip phones, and the dashboard in a
browser. It checks that a new extension is live in Asterisk within 2 s, both phones show online,
and the dots turn red during a call.

```sh
node scripts/e2e/m2-live.mjs up /tmp/sp-live-conf
# start the api with AMI_PORT=15038 AMI_SECRET=m2-live-secret ASTERISK_CONFIG_DIR=/tmp/sp-live-conf
node scripts/e2e/m1-t4.mjs http://127.0.0.1:8080 admin@example.com initial-admin-pw /tmp/shots
node scripts/e2e/m2-live.mjs check http://127.0.0.1:8080 admin@example.com correct-horse-battery-staple /tmp/shots
node scripts/e2e/m2-live.mjs down
```

`m3-t1.mjs` runs on the same setup (after `m1-t4.mjs`): it starts a fake voip.ms (a second Asterisk
that accepts one sub-account) on the m2-live network, creates the trunk in the UI and waits for
**Registered**, then presses Test. `m3-t2.mjs` (after `m3-t1.mjs`) adds a phone number routed to a user in the UI and
checks `sp-inbound` in Asterisk, and that the extension can no longer be deleted. `m3-t3.mjs` (after
both) checks the default outbound rules, the test box, a user's calling permission, and that
reordering changes the include order in Asterisk. `m3-t4.mjs` (after all three) runs a tiny SMTP sink on
127.0.0.1:2525 and a baresip phone as 101, then checks the dashboard warnings, Settings → Email and
Emergency, and the Test notifications button (email arrives, 101 rings, red banner). Nothing dials 911. The fake provider from `m3-t1.mjs` stays up until `m2-live.mjs down`: a container that took
over its IP would be identified as the trunk.

`pnpm test:asterisk` (golden-file load test, `call-test.ts` with 30 s two-way audio between two
baresip phones, and `trunk-test.ts` with registration against a fake provider) needs no api at all.

`m3-t5.mjs` is the M3-T5 acceptance and needs its own fresh database: it signs in with the
initial password, walks all ten wizard steps against a fake voip.ms, then proves an inbound call
to the DID rings the new user's softphone and an outbound call leaves with the DID as caller ID.

`m4-t2.mjs` is the M4-T2 acceptance (no browser): start m2-live with a voicemail dir
(`m2-live.mjs up <confDir> <vmDir>`) and the api with `VOICEMAIL_DIR=<vmDir>`. It runs the SMTP
sink (`smtp-sink.mjs`, shared with `m3-t4.mjs`), adds a user and extension 150 with voicemail,
leaves a message from a Local channel, and checks the email arrives within 10 s with a PCM 8 kHz
wav attached. The voicemail itself (MWI on a phone, `*97`) is covered by `pnpm test:asterisk`.

`m4-t3.mjs <baseUrl> <adminEmail> <adminPassword> <vmDir> <shotsDir>` is the M4-T3 acceptance on the
same setup: it adds a user with extension 160 and a baresip phone with the mwi module, leaves
messages, then as that user in the browser plays one (marks it read) and deletes another, each
time checking the phone's MWI goes off within 5 s. It records the "no answer" greeting with a
fake microphone and checks a caller hears it.

`m5-t1.mjs <baseUrl> <adminEmail> <adminPassword> <shotsDir>` is the M5-T1 check in Docker: start
the api with `WEBRTC_WS_URL=ws://127.0.0.1:18088/ws`. `m2-live.mjs up` publishes Asterisk's HTTP
server on 127.0.0.1:18088 and RTP 10000–10019/udp. The script sets LAN IP = the container and public
IP = 127.0.0.1 (so ICE offers 127.0.0.1), restarts telephony, then signs in as a new user, enables
the softphone with a fake microphone, and checks two-way audio to a baresip phone (171) in both
directions.

`m5-t2.mjs` (after `m5-t1.mjs`, same user) starts two baresip phones (172, 173) through
`phones.mjs` and checks the softphone features: the incoming call dialog, DTMF, hold (music on hold
at the other end), call waiting, blind and attended transfer, and "Use here" moving the softphone to
a second tab (`cdp.mjs` `newTab()`).

`m5-t3.mjs` (after `m5-t2.mjs`) is the M5-T3 acceptance. It watches People in one browser while 173
calls 172 and measures the time from Asterisk's hint changing to the dot changing (must be < 1 s).
Then a second browser, as a new user with desk phone 174 and the softphone off, clicks **Call** on
172: 174 must ring first (Asterisk channel order), then the two are connected.

`m6-t1.mjs` needs m2-live started with a sounds dir (`m2-live.mjs up <confDir> <vmDir> <soundsDir>`)
and the api with `SOUNDS_DIR=<soundsDir>`. It drops a generated wav on **Sounds & music**, uploads it,
checks that Asterisk can play `custom/<id>`, renames it, and deletes it, which is refused while it's
the recording notice. `cdp.mjs` `fill()`/`click()` take an optional selector to search within.

`m6-t2.mjs` (after `m1-t4.mjs`) creates ring group 500 in the UI with members 190 (never answers)
and 191 (auto-answer), and checks that a call from 192 rings both and is answered by 191. It then
switches the group to "one at a time" with 5 s each and checks that 190 rings alone before 191.

`m6-t3.mjs` (sounds dir like `m6-t1.mjs`) builds digital receptionist 600 in the UI. It uploads the
greeting through the form's SoundPicker, sends key 1 to 193 and key 2 to 194, and then a Local
channel sending DTMF presses 1, 2 and a wrong key (5): 193 or 194 rings, or "not a valid choice"
plays and then the greeting again.

`m6-t4.mjs` builds office hours in the UI. It paints Saturday 10–11 on the grid and checks that
Force closed / Force open route a call to 196 / 195 and set or clear AstDB `SP/TCOVR/<id>`. `*321`
and `*331` from the admin's own phone (197) must reach the database and the page, `*311` from a
non-admin phone must get "no service", and the 2026 US federal holiday import must reach the
dialplan.

`m6-t7.mjs` (after `m1-t4.mjs`) checks the feature codes from a real phone (198, belonging to user
`fwd@example.com`):

- `*78`/`*79` set DND (the database, AstDB and the page follow, and calls meanwhile go to
  voicemail).
- `*72199`/`*73` forward everything to 199. A `*72` to an outside number this user may not call is
  refused, removed from AstDB, and shown as a toast.
- `/me/settings` saves a no-answer forward.
- `*43` echo test and `*65` say my extension.
- `**200` and `*8` pick up a call ringing at 200.

`m6-check.mjs` is the M6 milestone check (after `m1-t4.mjs`). It builds DID → office hours → menu
(1 → a ring group of 221 and 222, 2 → 223; closed → 220's voicemail) and calls the trunk entry with
a caller ID over AMI. It checks the closed path; `*31N` from an admin's phone (220) forcing open;
the menu keys; and a number blocked on **Blocked numbers** being rejected (cause 21) while other
callers still get through.

`m7-t2.mjs` (after `m1-t4.mjs`, with the Asterisk image rebuilt for `cdr_manager.conf`) makes real
calls: 231 → 230 answered, then 231 → 230 while 230 is on DND (voicemail). It waits for them to
reach `calls` through the AMI `Cdr` events. It then checks the admin Call history (status filter,
expanded legs, CSV export), and as user `hist@example.com` (230): the missed call on Home,
`/me/calls`, and **Call back**, which rings 230's desk phone first and then 231.

`m7-t3.mjs` needs m2-live with sounds and recordings dirs (`m2-live.mjs up <conf> <vm> <sounds>
<recs>`) and the api with `SOUNDS_DIR` and `RECORDINGS_DIR`. It picks the recording notice under
Settings → Recording and ticks "Record every call" on a phone number in the UI. A caller then
reaches 240 (AMI Originate into the trunk entry, `ami.mjs`): the notice plays, MixMonitor records,
and the call's player in Call history serves the wav. The recording is also on the Recordings page.

`m7-t4.mjs`: seven auto-answer phones (260-266) and three concurrent calls (`channel originate`).
The dashboard's "Calls now" list must show exactly the channels in `core show channels concise`.
Then the admin hangs up one call (confirm dialog) and transfers another's caller to 266; the list
matches Asterisk after each step.

`m8-t1.mjs`: three auto-answer phones (agents 280 and 281, overflow 282). It builds queue 550 in
the UI (wait 20 s, then 282; callers wait even with no agent logged in), pauses 280 with `*45550`
from the phone and 281 with the queue page's button, and puts three callers in line (AMI Originate
of `Local/550@sp-from-ext`). The queue page and the dashboard tile show them live; unpausing 281
connects the longest waiting caller, a second caller goes to 282 after 20 s, a third hangs up.
`*45550` logs 280 back in, `*45551` (not an agent) plays `ss-noservice`, and the stats count
3 calls: 1 answered, 1 hung up, 1 timed out.

`m8-t2.mjs`: three auto-answer phones (290 parks, 291 belongs to a user, 292 picks up). A caller
reaches 290, which blind-transfers it to 700 (AMI BlindTransfer, what a phone's transfer key does):
it lands on 701 and the slot's hint goes InUse. The dashboard and the user's Home list it, the live
call shows "Parked", and **Pick up 701** on Home rings 291, which dials 701 and talks to the caller.
A second park takes 702 (`findslot = next`) and 292 picks it up by dialing 702.

`m8-t3.mjs` needs m2-live with a recordings dir. It builds room 800 in the UI (PIN 4826, admin PIN
917355, at most 3, recorded; the form refuses an admin PIN equal to the PIN). Callers are Local
channels typing with `SendDTMF`: a wrong PIN plays `conf-invalidpin` and asks again, the admin PIN
joins with flags `AM` in `confbridge list`, a 4th caller is turned away, and the recordings appear
on the Recordings page. Room 801 has no PIN; desk phones 300 and 301 dial in.

`m8-t4.mjs`: phones 320 and 321 answer manually but honor the auto-answer headers
(`sip_autoanswer=yes`, like a Yealink or Grandstream); 322 auto-answers and does the paging. It
builds paging group 850 in the UI. An ordinary call to 320 keeps ringing; a page from 322 is
answered by 320 and 321 by themselves (the INVITE carries `Call-Info: …;answer-after=0` and
`Alert-Info`, seen with `pjsip set logger on`), muted (`m` in `confbridge list`), and 322 (busy,
a member too) isn't paged. `*80320` is two-way; `*80999` plays `ss-noservice`.

`m8-t5.mjs` needs m2-live with a moh dir (`m2-live.mjs up` 5th argument, the api with `MOH_DIR`).
It makes the set `sales-jazz` on **Sounds & music** (refusing a bad name), uploads a tone into it,
and checks `moh show files`, a queue caller hearing it ("Started music on hold, class
'sales-jazz'"), a user's `moh_suggest`, delete refused while used, and the default music once the
set is empty.

`m8-check.mjs` is the M8 milestone check (after `m1-t4.mjs`): phones 340–343, a DID to queue 552 (550 is m8-t1's)
(agents 340 and 341, 30 s, then 342). 340 pauses with `*45552` and 341 from the api, three callers
come in from the trunk entry and wait; 341 comes back, gets caller 1, parks them on 701 (AMI
BlindTransfer to 700), 343 dials 701 and picks up; 341 takes caller 2 and caller 3 rings 342 after
30 s. The stats count 3 offered, 2 answered, 1 timed out.

`m9-t1.mjs` starts a fake voip.ms API on 127.0.0.1:18090 (start the api with
`VOIPMS_API_URL=http://127.0.0.1:18090/api/v1/rest.php`; the optional 5th argument is the api log).
With a wrong API password the trunk form shows voip.ms's reason and the built-in server list; with
the right one the list comes from `getServersInfo`. **Import numbers from voip.ms** imports one of
two numbers with its description as the label, the list marks it added, Phone numbers shows it,
and the api log never contains the API password. The trunk is created turned off, so nothing
registers to the real voip.ms.

`m10-t1.mjs` (after `m1-t4.mjs`) adds a Yealink on **Phones** (a short MAC is refused), reads the
URL, user name and password from the drawer, and checks the preview masks the passwords. Then,
as the phone: `/prov/<mac>.cfg` answers 401 without credentials and the file with them, and a
baresip phone given only the account from that file registers. The list then shows when it
fetched its settings.

`m10-t2.mjs` (after `m1-t4.mjs`) gives 360 BLF keys for 361 and the parking slot 701 and a
Yealink. From the phone's side: the config names the keys, clears the rest, has Central time, and
its phonebook URL (with the phone's credentials in it) returns the extensions. Asterisk has hints
for 361 and 701. With the company time zone set to Asia/Tokyo, the Phones page warns that phones
show UTC (the zone is put back after).

`m10-t3.mjs` (after `m1-t4.mjs`) as user `lin@example.com` (370): **My settings → Set up a phone
app** shows the Linphone QR and its link. Fetching the link with no other credentials (as Linphone
does) returns the account XML; a changed token gets 404; and a baresip phone given only the user
name and password from the XML registers. Scanning the QR with the Linphone app is left to a person.

`m10-t4.mjs` (after `m1-t4.mjs`): 380 calls 381; the admin, whose extension is 382 (desk phone),
presses **Listen**, **Whisper** and **Barge** on the dashboard. Each time 382 rings, answers and
runs `ChanSpy(PJSIP/380-…, qE / qEw / qEB)`; hanging up the call ends the barge leg too.

`m11-t1.mjs` (after `m1-t4.mjs`; needs the Asterisk image with `sp-vm-pincheck`; 5th argument: the
generated config dir) clicks through admin pages and fails on any Content-Security-Policy
violation; turns the phone ACL on with the phones' Docker network unlisted (390 can't register:
"Not match Endpoint ACL") and then listed (it registers); and changes 391's voicemail PIN from the
phone with `*98` and DTMF: `1111` is refused by `sp-vm-pincheck`, `7391` is stored by the api and
survives a later config write.

`m11-t1-totp.mjs` (after `m1-t4.mjs`): the admin turns two-step sign-in on from **My account**
(a wrong code refused, 10 recovery codes shown), signs out and back in with password then a code,
then with a recovery code (9 left), and turns it off with the password. Codes come from
`apps/api/src/auth/totp.ts` (node runs it directly).

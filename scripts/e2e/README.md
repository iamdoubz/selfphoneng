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

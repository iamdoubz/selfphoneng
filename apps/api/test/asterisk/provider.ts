// SPDX-License-Identifier: AGPL-3.0-or-later
// The fake voip.ms used by trunk-test.ts and cdr-record.ts: a second Asterisk on the test network.

/** The fake voip.ms: one sub-account that may register. */
export const providerPjsip = (SUB: { user: string; pass: string }) => `[transport-udp]
type = transport
protocol = udp
bind = 0.0.0.0:5060

[${SUB.user}]
type = endpoint
context = provider-in
disallow = all
allow = ulaw
auth = ${SUB.user}-auth
aors = ${SUB.user}

[${SUB.user}-auth]
type = auth
auth_type = userpass
username = ${SUB.user}
password = ${SUB.pass}

[${SUB.user}]
type = aor
max_contacts = 1
remove_existing = yes
`;

/**
 * provider-out: a mobile phone calls one of our DIDs. Like voip.ms, the Request-URI user is the
 * 10-digit DID (06 §3), sent to the sub-account's registered contact. Echo() returns the audio.
 */
export const providerDialplan = (MOBILE: string, SUB: { user: string }) => `[provider-out]
exten => _X.,1,Set(CALLERID(all)="Mobile" <${MOBILE}>)
 same => n,Dial(PJSIP/\${EXTEN}@${SUB.user},30)

[provider-echo]
exten => s,1,Answer()
 same => n,Echo()

; Our outbound calls arrive here: remember what the provider saw, then echo the audio.
[provider-in]
exten => _X.,1,Set(GLOBAL(LAST_IN)=to=\${EXTEN} from=\${CALLERID(num)} rpid=\${PJSIP_HEADER(read,Remote-Party-ID)})
 same => n,Answer()
 same => n,Echo()
`;

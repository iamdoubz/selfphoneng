# Analog phones (ATAs)

An analog telephone adapter (ATA) connects ordinary phones, with a phone cord, to SelfPhoneNG.
Each port of the ATA is one user's phone. Calls, voicemail (with the stutter dial tone when a
message waits), `*` codes, transfer with the hook flash, and 911 all work.

For now you set an ATA up by hand, in its own web page. Automatic setup, like the desk phones
get, is planned for the Grandstream HT802 V2 first.

Field names below are from Grandstream's HT802 V2 guide; other HT80x/HT81x models and firmware
versions may name them a little differently.

## 1. In SelfPhoneNG

1. **Users**: one user for each port you'll use (port 2 can stay empty).
2. Open the user, **Credentials** tab, **Reveal password**. Keep the server, port, username,
   password and **dial plan** at hand. Viewing it is recorded in the audit log.

You don't need to add the ATA on the Phones page: "Other (set up by hand)" there shows the same
settings, and is only for one line per device.

## 2. On the ATA (Grandstream HT802 V2)

Plug the ATA into the office network and find its address (in the router's list of devices, or
dial `***` then `02` on the analog phone to hear it). Open `http://<its address>`. The admin
password is on the label underneath; change it after you sign in.

On **FXS PORT 1** (and **FXS PORT 2** with the second user):

| Field | Value |
|---|---|
| Profile Active | Yes |
| Primary SIP Server | the server and port from the Credentials tab, for example `pbx.example.com:5060` |
| Outbound Proxy | empty |
| SIP Transport | UDP |
| SIP User ID | the username (the extension number) |
| Authenticate ID | the username again |
| Authenticate Password | the password |
| Name | the person's name (shown to the people they call) |
| SIP Registration | Yes |
| Allow Incoming SIP Messages from SIP Proxy Only | Yes: nobody but SelfPhoneNG can ring the phone |
| DTMF | RFC2833 first |
| Preferred Vocoder | PCMU first |
| Dial Plan | see below |

Click **Apply**. On the **Status** page the port should say **Registered** within a minute, and on
the server `pjsip show contacts` ([Troubleshooting](troubleshooting.md)) lists the extension.

### Dial plan

An analog phone has no send button: the ATA decides when you've finished dialing. Its default
dial plan, `{ x+ | … }`, always waits about 4 seconds after the last digit, even for 911. Paste
the **Dial plan** from the Credentials tab into **Dial Plan** instead. For the usual setup it
looks like:

```
{ 911 | 9911 | [2-9]xx[2-9]xxxxxx | 1[2-9]xx[2-9]xxxxxx | xxx | *x+ | **x+ }
```

- 911 and 9911 go out at once (US law requires 911 to work without a prefix).
- 10- and 11-digit numbers go out at once. International numbers (`011…`, when that route is on)
  go after a pause.
- Internal numbers and `*` codes go after a pause (an internal number could be the start of an
  outside one), or press **#** to send now.
- Numbers that match no rule can't be dialed from the ATA. It's made from your outbound routes
  and the lengths of your internal numbers: after changing either (a new route, or Settings →
  Numbering), copy it again.

## 3. Things to know

- **911:** each port's user has its own emergency caller ID, like any phone (Users →
  Emergency). An ATA that moves to another address needs the E911 address updated at voip.ms.
- **Fax:** not supported. Many fax machines still work through an ATA with Fax Mode set to
  **Pass-Through** and only PCMU allowed, but expect failures on long faxes. T.38 isn't set up on
  the SIP trunk.
- **Not on analog phones:** busy lights, the company phonebook, the browser phone features.
- **Caller ID** shows on analog phones that support it (US: Bellcore, the ATA's default).
- **Away from the office:** an ATA works anywhere a desk phone works. The phone network limit
  (Settings → Security) applies to it the same way.

// SPDX-License-Identifier: AGPL-3.0-or-later
// Static dialplan (03 §6.2): no DB data, but kept in code so all dialplan lives in one place.
// Variables set with a "__" prefix are inherited by every channel the call creates (03 §9).

export const STATIC_DIALPLAN = `; ─── Normalize a number. ARG1 = raw. Returns normalized in GOSUB_RETVAL. (matches 00 §8)
[sp-sub-normalize]
exten => s,1,Set(N=\${FILTER(0123456789+,\${ARG1})})
 same => n,ExecIf($["\${N:0:2}" = "+1"]?Set(N=\${N:1}))
 same => n,ExecIf($["\${N:0:1}" = "+"]?Set(N=011\${N:1}))
 same => n,ExecIf($[\${LEN(\${N})} = 10]?Set(N=1\${N}))
 same => n,Return(\${N})

; ─── Ring every registered device of a user. ARG1 = ext, ARG2 = seconds.
; Sets DIALSTATUS. Rings desk/softphone contacts (PJSIP/101) and browser (PJSIP/101-web).
[sp-sub-dial-user]
exten => s,1,Set(DS=\${PJSIP_DIAL_CONTACTS(\${ARG1})})
 same => n,Set(WS=\${PJSIP_DIAL_CONTACTS(\${ARG1}-web)})
 same => n,ExecIf($["\${DS}" != "" & "\${WS}" != ""]?Set(DS=\${DS}&\${WS}))
 same => n,ExecIf($["\${DS}" = ""]?Set(DS=\${WS}))
 same => n,GotoIf($["\${DS}" = ""]?unavail)
 same => n,Dial(\${DS},\${ARG2},tx)
 same => n,Return()
 same => n(unavail),Set(DIALSTATUS=CHANUNAVAIL)
 same => n,Return()

; ─── Call a user with all their personal rules.
; ARG1 = ext, ARG2 = ring seconds, ARG3 = voicemail enabled (1/0), ARG4 = record mode
[sp-sub-user]
exten => s,1,Set(__SP_TARGET=\${ARG1})
 same => n,ExecIf($["\${SP_DIRECTION}" = "inbound" & ("\${ARG4}" = "inbound" | "\${ARG4}" = "all")]?Gosub(sp-sub-record,s,1))
 same => n,GotoIf($["\${DB(SP/DND/\${ARG1})}" = "1"]?busy)
 same => n,Set(FWD=\${DB(SP/CFU/\${ARG1})})
 same => n,GotoIf($["\${FWD}" != ""]?forward)
 same => n,Gosub(sp-sub-dial-user,s,1(\${ARG1},\${ARG2}))
 same => n,GotoIf($["\${DIALSTATUS}" = "ANSWER"]?done)
 same => n,GotoIf($["\${DIALSTATUS}" = "BUSY"]?busy)
 same => n(noanswer),Set(FWD=\${DB(SP/CFNA/\${ARG1})})
 same => n,GotoIf($["\${FWD}" != ""]?forward)
 same => n,GotoIf($["\${ARG3}" = "1"]?vmu)
 same => n,Return()
 same => n(vmu),VoiceMail(\${ARG1}@default,u)
 same => n,Return()
 same => n(busy),Set(FWD=\${DB(SP/CFB/\${ARG1})})
 same => n,GotoIf($["\${FWD}" != ""]?forward)
 same => n,GotoIf($["\${ARG3}" = "1"]?vmb)
 same => n,Busy(5)
 same => n,Return()
 same => n(vmb),VoiceMail(\${ARG1}@default,b)
 same => n,Return()
 same => n(forward),Gosub(sp-sub-forward,s,1(\${FWD},\${ARG1}))
 same => n(done),Return()

; ─── Forward a call. ARG1 = target number, ARG2 = ext whose forward rule this is.
; Stops after 3 hops so 101→102→101 can't loop forever.
[sp-sub-forward]
exten => s,1,Set(__SP_FWDHOPS=$[\${IF($["\${SP_FWDHOPS}" = ""]?0:\${SP_FWDHOPS})} + 1])
 same => n,GotoIf($[\${SP_FWDHOPS} > 3]?stop)
 same => n,GotoIf($[\${DIALPLAN_EXISTS(sp-local-numbers,\${ARG1},1)}]?internal)
 same => n,Set(SP_CLASS=\${GLOBAL(SP_CLASS_\${ARG2})})
 same => n,Set(__SP_FORWARDED=1)
 same => n,Goto(sp-outbound-routes,\${ARG1},1)
 same => n(internal),Goto(sp-local-numbers,\${ARG1},1)
 same => n(stop),Return()

; ─── Start recording this call once. File: YYYY/MM/DD/<uniqueid>.wav under the monitor dir.
[sp-sub-record]
exten => s,1,GotoIf($["\${SP_REC}" != ""]?done)
 same => n,Set(__SP_REC=\${STRFTIME(\${EPOCH},,%Y/%m/%d)}/\${UNIQUEID}.wav)
 same => n,MixMonitor(\${SP_REC},b)
 same => n(done),Return()

; ─── Auto-answer headers for paging/intercom (Yealink, Grandstream, Polycom, Snom)
[sp-sub-autoanswer]
exten => s,1,Set(PJSIP_HEADER(add,Call-Info)=<sip:\${SP_EXT}>\\;answer-after=0)
 same => n,Set(PJSIP_HEADER(add,Alert-Info)=info=alert-autoanswer)
 same => n,Return()

[sp-vm-direct]
exten => _X.,1,Answer()
 same => n,VoiceMail(\${EXTEN}@default,u)
 same => n,Hangup()

[sp-ext-forward]
exten => _[0-9*#+].,1,Set(SP_CLASS=3)          ; admin-configured external destination
 same => n,Set(__SP_FORWARDED=1)
 same => n,Goto(sp-outbound-routes,\${EXTEN},1)

[sp-rg-member]                                  ; one member of a ring group (Local channel)
exten => _X.,1,GotoIf($["\${DB(SP/DND/\${EXTEN})}" = "1"]?skip)
 same => n,Gosub(sp-sub-dial-user,s,1(\${EXTEN},600))
 same => n(skip),Hangup()

[sp-queue-member]                               ; one queue agent (Local channel)
exten => _X.,1,Gosub(sp-sub-dial-user,s,1(\${EXTEN},600))
 same => n,Hangup()

[sp-from-ext]
include => sp-emergency-dial
include => sp-featurecodes
include => sp-local-numbers
include => sp-outbound-routes
`;

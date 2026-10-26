# 0005 — Our own mobile app: React Native (Expo) in the `mobile` repo

Owner, 2026-10-26: build an Android and iPhone app instead of only recommending Linphone (this
reverses the "native mobile apps" non-goal in 00 §2). One codebase for both, in its own repo
(`git.dou.bet/spng/mobile`, AGPL-3.0), with this repo as a git submodule for
`@selfphoneng/shared`. **Expo (React Native)** because the web client is already React 19 +
TypeScript + react-query + zustand + zod: the types, schemas and the SIP.js call code carry over,
which Flutter or Kotlin Multiplatform would not allow. Calls use **SIP.js + react-native-webrtc**
(both MIT) against the browser softphone's existing `-web` endpoint, so Asterisk stays the only SIP
stack; Linphone SDK and PJSIP were rejected (GPL with a commercial dual license, which conflicts
with App Store terms, and their React Native wrappers are abandoned). The native call screen is
**expo-callkit-telecom** (MIT: CallKit and Jetpack Core-Telecom); react-native-callkeep is
unmaintained and uses the older ConnectionService. v1 has **no push**: the app rings only while
open, and CFNA to a mobile number is the fallback (07 §5). Push comes later as FCM (Play) and
UnifiedPush (F-Droid) on Android and a relay for Apple's VoIP push; that adds a closed-source
dependency (Play Services) to the Play build, which needs its own decision then. iOS builds without
a Mac use **ios-builder** (MobAI-App, MIT), which runs Xcode on a macOS CI runner. For now the app
is built and sideloaded only; App Store and Play listings, and the AGPL/App Store terms question,
come later.

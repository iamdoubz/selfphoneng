// SPDX-License-Identifier: AGPL-3.0-or-later
// sp-from-ext includes these contexts; until their features exist they hold one undialable
// extension, because Asterisk doesn't create an empty context and then warns "tries to include
// nonexistent context". Each one moves to its feature's renderer.
export const PENDING_CONTEXTS = `; ─── Filled in by later milestones
[sp-emergency-dial]     ; M3-T4 (03 §6.14)
exten => pending,1,Hangup()

[sp-featurecodes]       ; M6-T7 (03 §6.13)
exten => pending,1,Hangup()
`;

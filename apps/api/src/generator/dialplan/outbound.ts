// SPDX-License-Identifier: AGPL-3.0-or-later
// Outbound routes (03 §6.12). Asterisk orders patterns inside one context by how specific they
// are, not by file order, so each route gets its own context and sp-outbound-routes includes
// them in position order: an include is only searched after the ones before it.
import { CLASS_RANK } from '@selfphoneng/shared';
import type { Snapshot } from '../load.ts';
import * as s from '../sanitize.ts';

export function renderOutbound(snap: Snapshot): string {
  const trunks = new Map(snap.trunks.filter((t) => t.enabled).map((t) => [t.id, t]));
  const routes = snap.routes
    .filter((r) => r.enabled && r.patterns.length)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  const top = ['[sp-outbound-routes]'];
  if (!routes.length) top.push('exten => pending,1,Hangup()       ; no routes yet');
  const out: string[] = [];
  for (const r of routes) {
    const id = s.ident(r.id);
    top.push(`include => sp-or-${id}        ; ${s.name(r.name)}`);

    const seen = new Set<string>();
    const pat = [`[sp-or-${id}]`];
    for (const p of r.patterns) {
      const match = s.pattern(p.match);
      if (seen.has(match)) continue; // a duplicate would be a load error
      seen.add(match);
      const strip = s.digits(String(p.strip));
      const prepend = p.prepend ? s.dialable(p.prepend) : '';
      pat.push(`exten => _${match},1,Goto(sp-route-${id},${prepend}\${EXTEN:${strip}},1)`);
    }

    const route = [
      `[sp-route-${id}]`,
      'exten => _X.,1,Set(__SP_DIRECTION=outbound)',
      ` same => n,GotoIf($[\${IF($["\${SP_CLASS}" = ""]?0:\${SP_CLASS})} < ${CLASS_RANK[r.requiredClass]}]?denied)`,
      ' same => n,ExecIf($["${SP_RECMODE}" = "outbound" | "${SP_RECMODE}" = "all"]?Gosub(sp-sub-record,s,1))',
      ' ; caller ID: route override > user > the DID a forwarded call came in on > default',
      ` same => n,Set(CID=${r.callerId ? s.digits(r.callerId) : ''})`,
      ' same => n,ExecIf($["${CID}" = ""]?Set(CID=${SP_OUTCID}))',
      ' same => n,ExecIf($["${CID}" = ""]?Set(CID=${SP_DID}))',
      ' same => n,ExecIf($["${CID}" = ""]?Set(CID=${SP_DEFAULT_CID}))',
      ' same => n,ExecIf($["${CID}" != ""]?Set(CALLERID(num)=${CID}))',
    ];
    const tries = r.trunkIds.map((tid) => trunks.get(tid)).filter((t) => t !== undefined);
    tries.forEach((t, i) => {
      const tid = s.ident(t.id);
      const next = i + 1 < tries.length ? `t${i + 1}` : 'busy';
      const label = i === 0 ? ' same => n' : ` same => n(t${i})`;
      route.push(`${label},Set(GROUP(sptrunk)=${tid})`);
      if (t.maxChannels)
        route.push(
          ` same => n,GotoIf($[\${GROUP_COUNT(${tid}@sptrunk)} > ${s.digits(String(t.maxChannels))}]?${next})`,
        );
      route.push(
        ` same => n,Dial(PJSIP/\${EXTEN}@trunk-${tid},120)`,
        ` same => n,GotoIf($["\${DIALSTATUS}" != "CHANUNAVAIL" & "\${DIALSTATUS}" != "CONGESTION"]?done)`,
      );
    });
    route.push(
      ' same => n(busy),Playback(all-circuits-busy-now)', // every trunk full, down or off
      ' same => n(done),Hangup()',
      ' same => n(denied),Playback(ss-noservice)',
      ' same => n,Hangup()',
    );
    out.push(pat.join('\n'), route.join('\n'));
  }
  return [top.join('\n'), ...out].join('\n\n') + '\n';
}

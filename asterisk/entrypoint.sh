#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
set -eu
# 1. Render templates that need secrets from env.
envsubst '${AMI_SECRET}' < /etc/asterisk/manager.conf.template > /etc/asterisk/manager.conf
chown asterisk:asterisk /etc/asterisk/manager.conf
chmod 600 /etc/asterisk/manager.conf
# 2. Make sure every generated include file exists so Asterisk can boot
#    before the api has generated anything.
for f in pjsip_selfphoneng.conf extensions_selfphoneng.conf extensions_globals_selfphoneng.conf voicemail_selfphoneng.conf \
         queues_selfphoneng.conf musiconhold_selfphoneng.conf rtp_selfphoneng.conf \
         confbridge_selfphoneng.conf; do
  [ -f "/etc/asterisk/selfphoneng/$f" ] || : > "/etc/asterisk/selfphoneng/$f"
done
# 3. First start: seed the default music-on-hold class with the stock opsound files (CC-BY-SA).
if [ -z "$(ls -A /var/lib/asterisk/moh/default 2>/dev/null)" ]; then
  mkdir -p /var/lib/asterisk/moh/default
  cp /usr/share/selfphoneng/moh-opsound/*.wav /var/lib/asterisk/moh/default/
fi
# Bind-mounted volumes arrive owned by the host; Asterisk runs as the asterisk user.
for d in /etc/asterisk/selfphoneng /var/lib/asterisk/db /var/lib/asterisk/moh /var/log/asterisk \
         /var/spool/asterisk/voicemail /var/spool/asterisk/monitor /var/lib/asterisk/sounds/custom; do
  mkdir -p "$d" && chown -R asterisk:asterisk "$d"
done
# 4. Run in foreground as the asterisk user.
exec /usr/sbin/asterisk -f -U asterisk -G asterisk -vvv

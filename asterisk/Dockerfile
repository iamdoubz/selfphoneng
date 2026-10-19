# SPDX-License-Identifier: AGPL-3.0-or-later
FROM debian:trixie-slim AS build
ARG ASTERISK_VERSION=24.0.0-rc2
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl wget pkg-config autoconf automake libtool \
      libedit-dev libjansson-dev libxml2-dev uuid-dev libsqlite3-dev libssl-dev \
      libsrtp2-dev libcurl4-openssl-dev libspeexdsp-dev libogg-dev libvorbis-dev \
      libopus-dev subversion bzip2 patch python3 xmlstarlet
WORKDIR /usr/src
RUN curl -fsSLO https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz \
 && curl -fsSLO https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.sha256 \
 && sha256sum -c asterisk-${ASTERISK_VERSION}.sha256 \
 && tar xzf asterisk-${ASTERISK_VERSION}.tar.gz
WORKDIR /usr/src/asterisk-${ASTERISK_VERSION}
# The mp3 decoder source (LGPL) must be fetched before configure so menuselect can enable format_mp3.
RUN contrib/scripts/get_mp3_source.sh || echo "mp3 source unavailable, format_mp3 skipped"
RUN ./configure --with-pjproject-bundled --with-jansson-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect \
      --disable BUILD_NATIVE \
      --enable format_mp3 \
      --enable CORE-SOUNDS-EN-WAV --enable CORE-SOUNDS-EN-G722 \
      --enable EXTRA-SOUNDS-EN-WAV --enable EXTRA-SOUNDS-EN-G722 \
      --enable MOH-OPSOUND-WAV \
      menuselect.makeopts \
 && make -j"$(nproc)" && make install DESTDIR=/out \
 && mkdir -p /out/usr/share/selfphoneng \
 && mv /out/var/lib/asterisk/moh /out/usr/share/selfphoneng/moh-opsound
# Debian's /var/run is a symlink to /run; a real directory here breaks the COPY below.
RUN rm -rf /out/var/run \
 && mkdir -p /out/etc/asterisk \
 && cp configs/samples/indications.conf.sample /out/etc/asterisk/indications.conf

FROM debian:trixie-slim
ARG ASTERISK_UID=1000
ARG ASTERISK_GID=1000
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      libedit2 libjansson4 libxml2 libuuid1 libsqlite3-0 libssl3t64 libsrtp2-1 \
      libcurl4t64 libspeexdsp1 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3 libopus0 \
      gettext-base ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g ${ASTERISK_GID} asterisk && useradd -u ${ASTERISK_UID} -g asterisk -d /var/lib/asterisk -s /usr/sbin/nologin asterisk
COPY --from=build /out/ /
COPY conf/ /etc/asterisk/
COPY entrypoint.sh /entrypoint.sh
COPY sp-vm-pincheck /usr/local/bin/sp-vm-pincheck
RUN chmod +x /entrypoint.sh /usr/local/bin/sp-vm-pincheck && mkdir -p /etc/asterisk/selfphoneng /var/lib/asterisk/db /var/lib/asterisk/moh /var/run/asterisk \
 && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk
ENTRYPOINT ["/entrypoint.sh"]

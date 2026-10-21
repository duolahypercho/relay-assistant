FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pil python3-tk xvfb openbox xdotool xclip scrot xterm mousepad \
    chromium fonts-dejavu-core fonts-noto-cjk fonts-noto-color-emoji ca-certificates tini nodejs git \
    libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw python3-uno python3-docx poppler-utils \
    fonts-crosextra-carlito fonts-crosextra-caladea \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 relay && useradd -u 1000 -g relay -m relay \
    && mkdir -p /workspace /tmp/.X11-unix && chown relay:relay /workspace 
RUN chmod 1777 /tmp/.X11-unix
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pyatspi at-spi2-core libatk-adaptor dbus-daemon \
    && rm -rf /var/lib/apt/lists/*
COPY docker/guest.py docker/accessibility.py docker/jobs.py docker/network-bridge.py docker/desktop-start.sh docker/runtime-start.sh docker/desktop-home.html /opt/relay/
COPY docker/office-policy.xcd /etc/libreoffice/registry/relay.xcd
ENV DISPLAY=:0 HOME=/workspace/.home LANG=C.UTF-8
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sh", "/opt/relay/desktop-start.sh"]

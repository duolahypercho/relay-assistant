# Disposable acceptance image; this is not the Relay server deployment image.
FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth dbus dbus-x11 libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libatk-bridge2.0-0t64 libdrm2 fonts-liberation ca-certificates openssl ffmpeg python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run desktop:package:deb && dpkg --install release/desktop/*.deb && mkdir /evidence && chown node:node /evidence
USER node
CMD ["dbus-run-session", "--", "xvfb-run", "-a", "node", "scripts/test-desktop-linux-guest.mjs"]

FROM docker:29.8.2-cli@sha256:35cfcf893c20f2931f4909151b5407aaaeab711277de7ce8b8f521f095d54c32 AS computer-client

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS listening
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends cmake make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:f3585ebf64df3e41b26c45d93bdb38b423ca1de0bf40cc4b6d320254867a75df https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/306c88f4d1286aec1bf96e544632897886af5501 /tmp/whisper-source.tar.gz
COPY server/local-listening-artifacts.mjs ./server/local-listening-artifacts.mjs
COPY scripts/build-listening-linux.mjs ./scripts/build-listening-linux.mjs
COPY native/audio/transcribe.c ./native/audio/transcribe.c
RUN node scripts/build-listening-linux.mjs /tmp/whisper-source.tar.gz /audio

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production RELAY_HOST=0.0.0.0 RELAY_PORT=4173 RELAY_DATA_DIR=/app/data PLAYWRIGHT_BROWSERS_PATH=/app/browsers
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium && mkdir -p /app/data /run/relay-secrets && chown -R node:node /app/data /app/browsers /run/relay-secrets && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=listening --chown=node:node /audio ./native/audio
COPY --from=computer-client /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=node:node /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=build --chown=node:node /app/third-party-licenses ./third-party-licenses
RUN mkdir -p /restore/data /restore/relay-secrets && chown -R node:node /restore
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.RELAY_PORT+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]

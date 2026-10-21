FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 relay && useradd -u 1000 -g relay -m relay \
    && mkdir /workspace && chown relay:relay /workspace
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]

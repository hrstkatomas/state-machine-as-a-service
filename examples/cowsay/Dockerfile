# Per-flow execution environment for the cowsay-fortune flow.
# Extends the platform runtime with the `fortune | cowsay | lolcat` toolchain.
#
# Only declare the environment here (FROM + packages + PATH). flowctl appends
# `COPY index.mjs /app/flows/index.mjs` automatically — don't add it yourself,
# and don't override the base ENTRYPOINT (the runner) or it won't boot.
FROM platform/flow-runtime:latest

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends fortune-mod fortunes cowsay lolcat \
  && rm -rf /var/lib/apt/lists/*
# fortune and cowsay install into /usr/games, which isn't on the default PATH.
ENV PATH="/usr/games:${PATH}"
USER node

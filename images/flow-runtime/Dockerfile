FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /workspace /app/flows \
  && chown -R node:node /workspace /app

COPY dist/runner.mjs /app/runner.mjs

USER node
WORKDIR /workspace
EXPOSE 8088
ENTRYPOINT ["node", "/app/runner.mjs"]

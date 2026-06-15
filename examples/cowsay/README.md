# example: cowsay-fortune

A one-node flow that runs `fortune | cowsay | lolcat` — the smallest possible demo of a
**per-flow execution environment**. Those tools aren't in the base `flow-runtime` image, so
the flow ships its own [`Dockerfile`](Dockerfile) that installs them on top of it.

## How the custom environment works

`flowctl deploy --dockerfile <path>` builds the flow's image from your Dockerfile instead of
the default `FROM platform/flow-runtime + COPY bundle`. The rules:

- Your Dockerfile **must** `FROM platform/flow-runtime:latest` (or an image derived from it) —
  the base provides the runner that every container boots into.
- Declare only the *environment* (packages, `ENV`, etc.). `flowctl` appends
  `COPY index.mjs /app/flows/index.mjs` for you — don't add it yourself, and don't override
  the base `ENTRYPOINT`.
- The Dockerfile content is folded into the image tag's hash, so changing dependencies
  produces a new image and a new flow version.

Here that means switching to `root` to `apt-get install fortune-mod fortunes cowsay lolcat`,
putting `/usr/games` on `PATH` (where `fortune`/`cowsay` land), then back to `node`. Because
`ctx.exec` runs `sh -c` with the container's environment, the `PATH` set in the Dockerfile is
visible to the flow's shell command automatically.

## Run it

```sh
# base image must exist first: pnpm build:image
node packages/flowctl/dist/main.js deploy examples/cowsay/src/index.ts \
  --dockerfile examples/cowsay/Dockerfile
node packages/flowctl/dist/main.js run cowsay-fortune
node packages/flowctl/dist/main.js logs <runId>   # the ASCII cow, in color
```

The `speak` node returns the rendered art on the `art` channel, so it's also visible in the
dashboard's state inspector for the run.

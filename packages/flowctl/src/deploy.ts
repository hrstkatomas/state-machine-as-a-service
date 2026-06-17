import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { resolveFlow } from "@flow/sdk";
import type { FlowManifest } from "@flow/contracts";
import type { ApiClient } from "./client.js";

const BASE_IMAGE = process.env.FLOW_BASE_IMAGE ?? "platform/flow-runtime:latest";
// Port 5001, not 5000: macOS Control Center's AirPlay Receiver squats on :5000 and swallows pushes.
const PUSH_REGISTRY = process.env.PUSH_REGISTRY ?? "localhost:5001";
const BUNDLE_COPY = "COPY index.mjs /app/flows/index.mjs\n";

export interface DeployOptions {
  /** Path to a custom Dockerfile that must `FROM platform/flow-runtime`. flowctl appends the bundle COPY. */
  dockerfile?: string;
}

/** A custom Dockerfile owns the environment (FROM + deps); flowctl always appends the bundle copy. */
async function buildDockerfile(options: DeployOptions): Promise<string> {
  if (!options.dockerfile) return `FROM ${BASE_IMAGE}\n${BUNDLE_COPY}`;
  return `${(await readFile(resolve(options.dockerfile), "utf8")).trimEnd()}\n${BUNDLE_COPY}`;
}

async function bundleFlows(entry: string, outDir: string): Promise<string> {
  const outfile = join(outDir, "index.mjs");
  await build({
    entryPoints: [resolve(entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
  });
  return outfile;
}

async function extractManifests(bundlePath: string): Promise<FlowManifest[]> {
  const mod = (await import(pathToFileURL(bundlePath).href)) as { flows?: unknown[]; default?: unknown };
  return (mod.flows ?? [mod.default]).map((exported) => resolveFlow(exported).toManifest());
}

function docker(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const proc = spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("error", fail);
    proc.on("exit", (code) => (code === 0 ? done() : fail(new Error(`docker ${args[0]} exited with ${code}`))));
  });
}

export async function deploy(entry: string, client: ApiClient, options: DeployOptions = {}): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "flowctl-"));
  try {
    console.log(`Bundling ${entry}...`);
    const bundlePath = await bundleFlows(entry, workDir);
    const manifests = await extractManifests(bundlePath);
    if (!manifests.length) throw new Error("No flows exported from entry module");

    const dockerfile = await buildDockerfile(options);
    const bundleHash = createHash("sha256").update(await readFile(bundlePath)).update(dockerfile).digest("hex").slice(0, 12);
    // imageRef is the registry-agnostic repo path stored in the DB; the executor prepends its
    // own registry host (push and pull hostnames differ on Docker Desktop). The unqualified tag
    // is also built locally so an imagePullPolicy=Never fallback works without a registry.
    const imageRef = `flows/${manifests[0]!.id}:${bundleHash}`;
    const pushRef = `${PUSH_REGISTRY}/${imageRef}`;
    await writeFile(join(workDir, "Dockerfile"), dockerfile);
    console.log(`Building image ${pushRef}${options.dockerfile ? ` (Dockerfile: ${options.dockerfile})` : ""}...`);
    await docker(["build", "-t", pushRef, "-t", imageRef, workDir]);
    console.log(`Pushing ${pushRef}...`);
    await docker(["push", pushRef]);

    for (const manifest of manifests) {
      const result = await client.post<{ flowId: string; version: number }>("/v1/deployments", { manifest, imageRef });
      console.log(`Deployed ${result.flowId} v${result.version} (${imageRef})`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

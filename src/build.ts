import * as core from "@actions/core";
import { which } from "@actions/io";
import { Result } from "better-result";
import { execa } from "execa";
import { z } from "zod/mini";
import { applyFlakeConfig } from "./flake-config.js";
import { readBuildInputs } from "./config.js";
import { Niks3, fetchAudience } from "./cache.js";
import { installClient } from "./install.js";
import { TokenProvider } from "./oidc.js";
import versions from "../versions.json" with { type: "json" };

const event = z.object({
  type: z.string(),
  attr: z.string(),
  success: z.boolean(),
  skipped: z.optional(z.boolean()),
  cacheStatus: z.optional(z.string()),
  outputs: z.optional(z.record(z.string(), z.nullable(z.string()))),
});

async function build() {
  const { server, args, enabled, uploadCached, nixOptions, flake, acceptFlakeConfig } =
    readBuildInputs();
  core.info(
    enabled
      ? `Uploads and TTL refresh enabled: ${server}`
      : "OIDC unavailable; skipping uploads and TTL refresh",
  );
  await applyFlakeConfig(flake, acceptFlakeConfig, nixOptions);
  let tokens: TokenProvider | undefined;
  if (enabled) {
    tokens = new TokenProvider(await fetchAudience(server), await installClient());
    await tokens.start();
  }
  try {
    const remote = new Set<string>();
    const built = await Result.tryPromise(async () => {
      core.info(
        enabled
          ? "Starting nix-fast-build with native uploads; remote cache hits are handled afterwards"
          : "Starting nix-fast-build without uploads",
      );
      const binary = await which("nix-fast-build");
      const child = execa(
        binary || "nix",
        binary
          ? args
          : ["run", `github:NixOS/nixpkgs/${versions.nixpkgs}#nix-fast-build`, "--", ...args],
        {
          stdin: "ignore",
          stderr: "inherit",
          buffer: false,
          reject: false,
        },
      );
      for await (const line of child) {
        const parsed = Result.try(() => event.parse(JSON.parse(line)));
        if (parsed.isErr()) {
          core.setFailed(parsed.error);
          continue;
        }
        const result = parsed.value;
        core.info(
          `${result.type} ${result.attr}: ${result.success ? "ok" : "failed"}` +
            (result.cacheStatus ? `, cache=${result.cacheStatus}` : "") +
            (result.skipped ? ", skipped" : ""),
        );
        if (!result.success) process.exitCode = 1;
        if (
          tokens &&
          result.success &&
          !result.skipped &&
          result.type === "EVAL" &&
          result.cacheStatus === "cached"
        ) {
          for (const path of Object.values(result.outputs ?? {})) if (path) remote.add(path);
        }
      }
      const result = await child;
      if (result.failed && result.exitCode === undefined) throw result;
      return result.exitCode ?? 1;
    });
    core.info(
      built.isErr()
        ? "nix-fast-build interrupted; continuing with remote cache hits collected so far"
        : `nix-fast-build exited with code ${built.value}; native upload processing has ended`,
    );
    // Native uploads have drained. Only skipped remote outputs need extra work.
    if (tokens) await new Niks3(server, nixOptions, tokens).sync([...remote], uploadCached);
    if (built.isErr()) throw built.error;
    process.exitCode = built.value || process.exitCode || 0;
  } finally {
    await tokens?.stop();
  }
}

const result = await Result.tryPromise(build);
if (result.isErr()) core.setFailed(result.error);

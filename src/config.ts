import * as core from "@actions/core";
import { parseArgsStringToArgv } from "string-argv";

export function readBuildInputs() {
  const url = new URL(core.getInput("server-url", { required: true }));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("server-url must be HTTP(S), without credentials, query, or fragment");
  }
  const server = url.href.replace(/\/$/, "");
  const enabled = Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  );
  const flake = core.getInput("flake", { required: true });
  const args = parseArgsStringToArgv(core.getInput("args"));
  const reserved = new Set([
    "--flake",
    "-f",
    "--file",
    "--niks3-server",
    "--skip-cached",
    "--no-skip-cached",
    "--stream-json-lines",
    "--nom",
    "--no-nom",
    "--accept-flake-config",
    "--no-accept-flake-config",
    "--",
  ]);
  // Recognize only options relevant to our cache/config integration. Leave
  // full argument validation and unknown options to nix-fast-build.
  const nixOptions: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=")[0]!;
    if (reserved.has(name) || (arg.startsWith("-f") && !arg.startsWith("--")))
      throw new Error(`The action manages ${name}; remove it from args`);
    if (name === "--option") {
      const option = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      const value = args[++i];
      if (!option || value === undefined) throw new Error("--option requires a name and value");
      if (option === "accept-flake-config")
        throw new Error("The action manages accept-flake-config; use its input instead");
      nixOptions.push("--option", option, value);
    } else if (name === "--override-input") {
      i += 2;
    }
  }
  return {
    nixOptions,
    flake,
    acceptFlakeConfig: core.getBooleanInput("accept-flake-config"),
    server,
    enabled,
    uploadCached: core.getBooleanInput("upload-cached"),
    args: [
      "--flake",
      flake,
      ...args,
      "--skip-cached",
      "--stream-json-lines",
      "--no-nom",
      ...(enabled ? ["--niks3-server", server] : []),
    ],
  };
}

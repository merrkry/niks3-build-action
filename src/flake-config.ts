import { execa } from "execa";
import { z } from "zod/mini";

const line = z
  .string()
  .check(z.refine((value) => !/[\r\n]/.test(value), "Nix config values must fit on one line"));
const settings = z.record(
  z.string().check(z.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)),
  z.union([line, z.boolean(), z.number(), z.array(line)]),
);

export async function applyFlakeConfig(flake: string, accept: boolean, options: string[]) {
  const lines = [process.env.NIX_CONFIG ?? ""];
  if (accept) {
    // Let Nix resolve local paths, registries and remote URLs. Do not parse
    // flake.nix ourselves or evaluate the flake's package outputs.
    const metadata = await execa(
      "nix",
      [
        "flake",
        "metadata",
        "--json",
        "--no-write-lock-file",
        "--accept-flake-config",
        ...options,
        flake.split("#")[0] || ".",
      ],
      { stderr: "inherit" },
    );
    const { url } = z.object({ url: z.string() }).parse(JSON.parse(metadata.stdout));
    const config = await execa(
      "nix",
      [
        "eval",
        "--json",
        "--impure",
        "--expr",
        '(import ((builtins.getFlake (builtins.getEnv "NIKS3_FLAKE_REF")).outPath + "/flake.nix")).nixConfig or {}',
        ...options,
      ],
      { stderr: "inherit", env: { NIKS3_FLAKE_REF: url } },
    );
    for (const [name, value] of Object.entries(settings.parse(JSON.parse(config.stdout)))) {
      lines.push(`${name} = ${Array.isArray(value) ? value.join(" ") : String(value)}`);
    }
  }
  // Process-local: every child inherits this, later workflow steps do not.
  lines.push(`accept-flake-config = ${accept}`, "");
  process.env.NIX_CONFIG = lines.join("\n");
}

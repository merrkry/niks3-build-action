import * as core from "@actions/core";
import { which } from "@actions/io";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { quote } from "shell-quote";
import versions from "../versions.json" with { type: "json" };

export async function installClient() {
  const work = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "niks3-action-"));
  core.saveState("work", work);
  if (!(await which("niks3"))) {
    await writeFile(
      join(work, "niks3"),
      `#!/bin/sh\nexec ${quote(["nix", "run", `github:Mic92/niks3/v${versions.niks3}#niks3`, "--"])} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${work}${delimiter}${process.env.PATH ?? ""}`;
  }
  const file = join(work, "token");
  process.env.NIKS3_AUTH_TOKEN_FILE = file;
  return file;
}

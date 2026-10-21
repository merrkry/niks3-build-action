import { getState, setFailed } from "@actions/core";
import { rm } from "node:fs/promises";
import { Result } from "better-result";

for (const key of ["work", "roots"]) {
  const work = getState(key);
  if (!work) continue;
  const result = await Result.tryPromise(() => rm(work, { recursive: true, force: true }));
  if (result.isErr()) setFailed(result.error);
}

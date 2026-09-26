import { getState, setFailed } from "@actions/core";
import { rm } from "node:fs/promises";
import { Result } from "better-result";

const work = getState("work");
if (work) {
  const result = await Result.tryPromise(() => rm(work, { recursive: true, force: true }));
  if (result.isErr()) setFailed(result.error);
}

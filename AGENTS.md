# AGENTS.md

## Verification

- Use `pnpm run format` for formatting.
- Use `pnpm run check` for full static analysis, build, and tests. This must pass before calling work done.

## Build Artifacts

- `dist/` is the bundle GitHub runs and must be committed. After changing `src/`, dependencies, or build config, run `pnpm run build` and commit the updated `dist/` in the same commit.
- CI fails if `dist/` differs from a fresh build.

# niks3-build-action

GitHub Action that builds a flake with [nix-fast-build](https://github.com/Mic92/nix-fast-build) and pushes the results to a [niks3](https://github.com/Mic92/niks3) cache.

nix-fast-build skips outputs that already exist in a substituter. This action handles those outputs too:

- Already in niks3: the action refreshes their roots, so niks3 does not expire them.
- Only in other substituters: the action downloads them and pushes them to niks3. Disable this with `upload-cached: false`.

## Minimal config

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: NixOS/nix-installer-action@v1
      - uses: Mic92/niks3-action@v1
        with:
          server-url: https://cache.example.com
          skip-push: true
      - uses: merrkry/niks3-build-action@master
        with:
          server-url: https://cache.example.com
          flake: .#checks.x86_64-linux
```

See [example.yml](example.yml) for a full config with comments.

## Inputs

| Input                 | Default  | Description                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `server-url`          | required | niks3 server URL.                                                                             |
| `flake`               | required | Flake reference and attribute to build, such as `.#checks.x86_64-linux`.                      |
| `args`                | `""`     | Extra nix-fast-build arguments. Split like a shell command line, but without shell expansion. |
| `accept-flake-config` | `true`   | Use the target flake's `nixConfig` while evaluating, building, and downloading.               |
| `upload-cached`       | `true`   | Push outputs that only exist in other substituters to niks3.                                  |

The action sets these nix-fast-build options itself, and fails if `args` contains them: `--flake`, `-f`/`--file`, `--niks3-server`, `--skip-cached`, `--stream-json-lines`, `--nom`, and `--accept-flake-config` (including `--option accept-flake-config`). Other `--option` values also apply to the action's own `nix` calls.

## Notes

- Authentication uses GitHub OIDC, so the job needs `id-token: write`. Without it, as in pull requests from forks, the action only builds.
- `nix-fast-build` and `niks3` are taken from `PATH` if present. Otherwise they run from the nixpkgs revision pinned in [versions.json](versions.json).
- `accept-flake-config` only affects processes started by this action. Later steps keep the original Nix config.
- The job fails if any build fails, but outputs that were already cached are still refreshed or pushed first.
- [Mic92/niks3-action](https://github.com/Mic92/niks3-action) adds niks3 as a substituter, so outputs already in niks3 are not rebuilt. `skip-push: true` leaves uploading to this action.

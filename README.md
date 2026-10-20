# dsh-codex-bridge

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that lets the agent read the local **Codex CLI** quota and delegate hard tasks to `codex exec` with a model and reasoning effort that fit the current ChatGPT-plan budget.

It is a host-only DSH plugin: two tools, no browser half, no build step, and no npm dependencies.

> Unofficial community plugin. Not affiliated with or endorsed by OpenAI, Codex, or DeepSeek.

## What it adds

| Tool | What it does | Codex usage |
|---|---|---|
| `codex_status` | Reads the 5-hour and weekly ChatGPT-plan windows, reset times, credits, the model ladder, and the quota-aware recommendation. | none |
| `codex_delegate` | Runs one non-interactive `codex exec` task in a chosen directory and returns the answer, token usage, thread id, and the quota left afterwards. | yes |

`codex_status` talks to `codex app-server` (`account/rateLimits/read`, `model/list`). `codex_delegate` is the only path that spends model usage.

## Quota policy

The deployment default is intentionally narrow:

- **Default:** `gpt-6.1-sol` at reasoning effort **`high`**.
- **Reserve:** when either window has **10% or less left**, auto switches to `gpt-5.6-sol` at `medium`.
- **`gpt-6-astra`:** never selected automatically. An explicit `model: "gpt-6-astra"` is refused unless the caller also sets `allow_expensive_model: true`, because it consumes the shared quota much faster.
- **Floors:** the model never goes below `gpt-5.6-sol`; reasoning effort never goes below `medium`.
- **Blocked:** at 95% used, or when the backend disallows ordinary usage, runs are refused unless `allow_low_quota: true`.

Recommendation table (`model=auto`, `reasoning_effort=auto`):

| Complexity | Normal (both windows > 10% left) | Reserve (either window ≤ 10% left) |
|---|---|---|
| `simple` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `medium` |
| `standard` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `medium` |
| `hard` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `medium` |
| `critical` | `gpt-6.1-sol` / `high` | `gpt-5.6-sol` / `high` |

Explicit choices are validated, never silently downgraded. A refusal names the selectable models or the missing opt-in.

### About `gpt-6.1-sol`

The installed Codex CLI build may not list `gpt-6.1-sol` in `model/list` even though the backend accepts it (a real `codex exec` run confirmed this during development). `codex_status` therefore shows it as a **configured** model and warns that `codex exec` may print a missing-model-metadata warning. Change `defaultModel` / `minModel` in the config if your Codex account uses different ids.

## Install

In the DSH Web GUI, open **Plugins**, add the package directory or install the bundle through the plugin manager:

```json
{ "action": "install_bundle", "target": "/path/to/dsh-codex-bridge" }
```

From GitHub (once the repository is published):

```bash
dsh plugin --profile web add github:AK-blank/dsh-codex-bridge#v1.1.1
```

From a local checkout:

```bash
dsh plugin --profile web add /path/to/dsh-codex-bridge
dsh --profile web --dump-config | grep -A2 codex-bridge
```

Then restart `dsh web` if the host process already cached an older module. Host-side plugin code is cached per process; a new bundle row activates live, but edits to `lib/*.js` need a restart.

Requirements: DSH `0.2.0-rc.2` (the tested release), Node.js 20+, and a signed-in Codex CLI (`codex login`).

## Configuration

Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: codex-bridge
  name: dsh-codex-bridge
  config:
    minModel: gpt-5.6-sol
    defaultModel: gpt-6.1-sol
    expensiveModel: gpt-6-astra
    minEffort: medium
    defaultEffort: high
    reservePercent: 10
    stopPercent: 95
    statusCacheSeconds: 30
    defaultSandbox: read-only
    ephemeral: true
    maxTimeoutSeconds: 1800
    maxOutputChars: 16000
    codexCommand: codex
    codexHome: ''
```

| Key | Default | Meaning |
|---|---|---|
| `minModel` | `gpt-5.6-sol` | model floor and reserve fallback |
| `defaultModel` | `gpt-6.1-sol` | normal default (may be configured even when not listed by the CLI) |
| `expensiveModel` | `gpt-6-astra` | explicit opt-in only |
| `minEffort` | `medium` | lowest reasoning level ever used |
| `defaultEffort` | `high` | reasoning level for ordinary and hard work |
| `reservePercent` | `10` | fall back when either window has this much or less left |
| `stopPercent` | `95` | block ordinary runs at this used percentage |
| `statusCacheSeconds` | `30` | quota snapshot cache |
| `defaultSandbox` | `read-only` | Codex sandbox unless the caller overrides it |
| `ephemeral` | `true` | do not persist each delegation under `~/.codex/sessions` |
| `maxTimeoutSeconds` | `1800` | hard wall-clock limit per delegation |
| `maxOutputChars` | `16000` | answer characters returned to the model |
| `codexCommand` | `codex` | executable name or absolute path |
| `codexHome` | empty | empty inherits the host environment |

## Usage

Ask the agent:

> Check the Codex quota, then delegate this hard problem to Codex with the right model and effort.

The agent calls `codex_status`, picks a complexity (or passes explicit `model` / `reasoning_effort`), then calls `codex_delegate`. The task must be self-contained: Codex cannot see the DSH conversation, so include absolute paths, symptoms, constraints, and the exact deliverable.

Default sandbox is `read-only`. Pass `sandbox: "workspace-write"` and a `cwd` only when Codex must edit files.

## Verification

```bash
node selftest.mjs             # offline: package contract, policy, rendering, registration
node selftest.mjs --live      # also read the real quota and model ladder (no model usage)
node selftest.mjs --live-exec # also run one tiny codex exec task (spends a little usage)
```

The offline suite covers the quota tiers, the 10% reserve switch, the astra guard, the model/effort floors, blocked-quota refusal, rendering, and the bundle/registration contract. Live checks verify the real `codex app-server` response and the configured ladder. The repository's GitHub Actions workflow runs the offline suite on every push.

## Limitations

- The app-server methods belong to the installed Codex CLI version; an incompatible upgrade fails with `CODEX_RPC` / `CODEX_PROTOCOL` instead of inventing data.
- Codex does not share this conversation's context.
- Default `read-only` means Codex can read `cwd` but cannot write; `workspace-write` keeps writes under `cwd` and still follows Codex's own sandbox/network policy.
- The returned quota is a percentage snapshot, not an exact token reservation; the tiers are spend guardrails.
- `gpt-6.1-sol` availability and model metadata depend on the Codex CLI build and account; configure other ids if needed.

## Community listing

`docs/awesome-entry.yml` is the prepared entry for the community directory [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) (category `usage`). That directory requires the repository to be at least one day old before a PR is accepted, so the PR is intentionally not opened on publish day. The repository also carries the `dsh-plugin` topic for automatic indexes.

## License

MIT. See [LICENSE](LICENSE).

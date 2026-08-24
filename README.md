# dsh-token-limits-notice

DSH 上下文限额提示插件 · DeepSeek Harness plugin that reminds you (and the model) every time the conversation context crosses the 1M-token limit.

English | [中文](README.zh.md)

## What it does

DeepSeek V4 defaults to a 1M-token context window. This plugin watches each agent's pre-step message surface and, when the next request's prompt is estimated to exceed a configured token threshold (default 1,000,000), appends ONE advisory reminder to that request's messages telling the model it is at the context-window limit — output may be truncated or requests may fail, so it should stay concise or recommend compacting the conversation.

- **Model-facing guard** (this package): injects a `notice`-form context message once per crossing (under → over), never vetoing or rewriting requests.
- **GUI warning ring + toast**: lives in the DeepSeek Harness monorepo shell (`ui-conversation`'s `ContextMeter`/composer) — it turns the context ring red and fires a one-time toast when usage crosses 1M. This package is the host-side guard only.

## Install

In a dsh checkout or installed CLI, register the bundle into the web profile:

```sh
dsh plugin --profile web add dsh-token-limits-notice
```

or add the row manually to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: context-size-reminder
      name: 'dsh-token-limits-notice'
      config:
        thresholdTokens: 1000000
```

Requires the `token-meter` service (the dsh base bundle mounts it by default).

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `thresholdTokens` | `number` | `1000000` | Estimated next-prompt tokens above which the model receives the reminder. Must be a positive integer; anything else fails loud at plugin load. |
| `reminderText` | `string` | built-in | Replaces the default reminder text entirely. |

## How it works

At each `agent/pre-step`, the guard reads `ctx.tokenMeter.measure(session)` — the same replay-aware meter that feeds the composer's context ring — and adds the heuristic price of the pending pre-step messages, which the session log does not yet contain. When the estimate first crosses `thresholdTokens`, the guard delegates via `next()` and appends one reminder to that request's `enter` decision (source `{kind: 'plugin', plugin: 'dsh-token-limits-notice', form: 'notice'}`), which the loop logs as an injected `user/message`.

- **Once per crossing**: a per-agent `WeakMap` latch fires the reminder only on under → over transitions, so a persistent over-limit surface never re-injects the same nudge and cannot bloat the context it protects. A compaction that brings usage back under arms the next crossing.
- **Append, never prepend**: the reminder follows the conversation so the request prefix keeps its KV-cache reuse.
- **In-memory only**: a resumed session starts with a fresh latch; the guard is a heuristic nudge, not a logged invariant.

## Model Experience

### Default reminder

#### What the model sees

When the estimated next prompt first crosses `thresholdTokens`, that agent's request receives the reminder below as its final message — `thresholdTokens` is interpolated into the text and `reminderText` replaces it entirely when configured. No tool schema or request text is changed.

##### Reminder text

```markdown
Context size warning: the model-visible context has exceeded 1000000 tokens.
The conversation is at the context-window limit: responses may be truncated
and requests may fail. If the task is not complete, keep subsequent replies
concise and recommend compacting the conversation or starting a new session
to free context.
```

#### Token effect

Zero tokens before the crossing; the reminder (a few hundred tokens) is retained history for that agent, appended once per crossing.

#### KV Cache effect

Append-only; the reminder lands after the reusable request prefix and does not invalidate existing KV-cache entries.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Tests run against the published `@deepseek-ai/*` packages (0.1.0-rc.8) with a scripted mock adapter — no network or API key needed.

## Known Limitations and Deferred Work

- The measurement is an estimate anchored to provider usage; it is not a request gate. A prompt that crosses the threshold still goes out, and the provider's own limit enforcement is unchanged.
- The latch is in-memory: a persisted session resumed after a restart arms its first over-limit pre-step again (the later reminder is the accepted cost of a stateless heuristic nudge).
- The GUI warning (red ring + toast) is a DeepSeek Harness shell change and is not part of this standalone package; the host guard here is model-facing only.

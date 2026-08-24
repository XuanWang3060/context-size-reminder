/**
 * Advisory per-agent context-size detector. It watches each agent's pre-step
 * message surface and, when the next request's prompt is estimated to exceed
 * a configured token threshold, appends ONE reminder to that request's
 * messages — never vetoing, rewriting, or touching the tool chain. The
 * decision (compact, stay concise, or continue) stays entirely with the model.
 * Configuration and chain semantics live in the package README.
 * @module @deepseek-ai/dsh-context-size-reminder
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'

export const name = 'context-size-reminder'

/** The token-meter service prices every measurement; absent it the guard cannot run. */
export const inject = ['tokenMeter']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time check in `apply` (a non-positive or non-integer threshold fails
 * loud at plugin load, never a silent fall-back to the default).
 */
export interface Config {
  /**
   * Estimated next-request prompt tokens above which the model receives the
   * reminder (default 1,000,000 — the DeepSeek V4 1M-token window).
   */
  thresholdTokens?: number
  /** Custom reminder text; omitted uses the default advisory. */
  reminderText?: string
}

export const Config: z<Config> = z.object({
  thresholdTokens: z.number().default(1_000_000),
  reminderText: z.string(),
})

/**
 * The `{kind:'plugin'}` source stamped on every reminder this guard injects —
 * the label is load-bearing (an unlabeled context would render as a user
 * prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'context-size-reminder' }

/** The default reminder, interpolating the effective threshold. */
function defaultReminder(thresholdTokens: number): string {
  return 'Context size warning: the model-visible context has exceeded '
    + `${thresholdTokens} tokens.` + ' The conversation is at the context-window limit: '
    + 'responses may be truncated and requests may fail. If the task is not complete, '
    + 'keep subsequent replies concise and recommend compacting the conversation or '
    + 'starting a new session to free context.'
}

/**
 * Validate the threshold per the fail-loud contract.
 * @param value - raw configured threshold.
 * @returns the validated threshold.
 */
function validateThreshold(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`context-size-reminder: invalid thresholdTokens ${value} — must be an integer >= 1`)
  }
  return value
}

/**
 * Estimate the tokens of the NEXT request's prompt: the meter's current
 * pressure (provider-anchored input plus cache plus signed surface movement,
 * or the full heuristic price before any provider sample) plus the pending
 * pre-step messages, which the session log does not yet contain.
 * @param meter - the session's token meter.
 * @param session - the agent's durable session.
 * @param messages - the model-visible messages about to be sent.
 * @returns the estimated next-request prompt tokens.
 */
function nextPromptTokens(
  meter: TokenMeter,
  session: Session,
  messages: readonly UserMessage[],
): number {
  const measurement = meter.measure(session)
  const anchored = measurement.baseline.kind === 'usage'
    ? measurement.baseline.usage.inputTokens
      + (measurement.baseline.usage.cacheReadTokens ?? 0)
      + (measurement.baseline.usage.cacheWriteTokens ?? 0)
      + measurement.surfaceDeltaTokens
    : measurement.totalTokens
  let pending = 0
  for (const message of messages) pending += meter.estimateMessage(message)
  return anchored + pending
}

/**
 * Install the guard's listener.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; the threshold is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const thresholdTokens = validateThreshold(config.thresholdTokens as number)
  const reminderText = config.reminderText ?? defaultReminder(thresholdTokens)

  // Per-agent over-limit latch: the reminder fires once per crossing (under →
  // over), so a persistent over-limit surface does not re-inject the same
  // nudge on every step and re-bloat the very context being warned about.
  const overLimit = new WeakMap<Agent, boolean>()

  const reminder = createUserMessage({
    content: [{ type: 'text', text: reminderText }],
    source: {
      ...PLUGIN_SOURCE,
      form: 'notice',
      summary: `context exceeded ${thresholdTokens} tokens`,
    },
  })

  ctx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const over = nextPromptTokens(ctx.tokenMeter, agent.session, downstream.messages) > thresholdTokens
    const previous = overLimit.get(agent) ?? false
    overLimit.set(agent, over)
    if (!over || previous) return downstream
    // Append, never prepend: the reminder follows the conversation so the
    // request prefix (system + tools + history) keeps its KV-cache reuse.
    return { ...downstream, messages: [...downstream.messages, reminder] }
  })
}
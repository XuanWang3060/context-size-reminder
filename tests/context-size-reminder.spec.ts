import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ContextSizeGuard from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * Behavior suite for the context-size guard: threshold gating, the
 * once-per-crossing latch, per-agent keying, custom reminder text, and
 * fail-loud config validation — all driven through a real agent loop
 * against a scripted mock adapter (no network).
 */

/** Boot the core spine + the token meter + the guard. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  void new TokenMeter(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ContextSizeGuard, config)
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every injected-context user message in the agent's log, flattened to joined text + source. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind !== 'user')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

const guardSource = (summary: string) => ({
  kind: 'plugin',
  plugin: 'context-size-reminder',
  form: 'notice',
  summary,
})

/** A user message long enough to clear a small threshold under the meter's fixed 4-char/token density. */
const BIG_TEXT = 'x'.repeat(400)

describe('threshold gating', () => {
  it('injects no reminder while the next prompt stays under the threshold', async () => {
    const ctx = await harness({ thresholdTokens: 500 })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(0)
  })

  it('injects exactly one reminder when the next prompt crosses the threshold', async () => {
    const ctx = await harness({ thresholdTokens: 50 })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: BIG_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const found = reminders(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('exceeded 50 tokens')
    expect(found[0]!.source).toEqual(guardSource('context exceeded 50 tokens'))
  })

  it('uses the custom reminderText when configured', async () => {
    const ctx = await harness({ thresholdTokens: 50, reminderText: 'custom nudge' })
    const adapter = new MockAdapter([textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: BIG_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)[0]!.text).toBe('custom nudge')
  })
})

describe('once-per-crossing latch', () => {
  it('does not re-inject the reminder on a later step while the surface stays over the threshold', async () => {
    const ctx = await harness({ thresholdTokens: 50 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'hi' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: BIG_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(reminders(agent)).toHaveLength(1)
  })
})

describe('per-agent keying', () => {
  it("keeps each agent's latch independent", async () => {
    const ctx = await harness({ thresholdTokens: 50 })
    const adapter = new MockAdapter([textResponse('done'), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const over = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const under = ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    over.followup(createUserMessage({ content: [{ type: 'text', text: BIG_TEXT }], source: { kind: 'user' } }))
    under.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await Promise.all([waitForIdle(ctx, over), waitForIdle(ctx, under)])
    expect(reminders(over)).toHaveLength(1)
    expect(reminders(under)).toHaveLength(0)
  })
})

describe('config validation', () => {
  async function spine(): Promise<Context> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    void new TokenMeter(ctx)
    return ctx
  }

  it('rejects a zero threshold', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ContextSizeGuard, { thresholdTokens: 0 })).rejects.toThrow(/integer >= 1/)
  })

  it('rejects a negative threshold', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ContextSizeGuard, { thresholdTokens: -5 })).rejects.toThrow(/integer >= 1/)
  })

  it('rejects a fractional threshold', async () => {
    const ctx = await spine()
    await expect(ctx.plugin(ContextSizeGuard, { thresholdTokens: 2.5 })).rejects.toThrow(/integer >= 1/)
  })
})
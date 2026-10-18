import { describe, expect, it, vi } from 'vitest';
import { BedrockLlm } from './llm.js';
import { ProviderContext } from './infra.js';

const ok = { output: { message: { content: [{ text: 'OK' }] } }, usage: { inputTokens: 1, outputTokens: 1 } };

describe('Bedrock model IDs', () => {
  it('retries a bare ID through the global inference profile and remembers it', async () => {
    const send = vi.fn(async (cmd: { input: { modelId: string } }) => {
      if (!cmd.input.modelId.startsWith('global.')) throw new Error('Invocation of model ID anthropic.claude-haiku-5-5 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.');
      return ok;
    });
    const llm = new BedrockLlm('us-east-1', 'anthropic.claude-haiku-5-5', undefined, { send } as never);
    const args = { system: 's', prompt: 'p', maxTokens: 5 };
    expect(await llm.complete(args, new ProviderContext())).toBe('OK');
    expect(await llm.complete(args, new ProviderContext())).toBe('OK');
    expect(send.mock.calls.map((c) => c[0].input.modelId)).toEqual(['anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-haiku-5-5']);
  });

  it('does not touch other errors or IDs that already have a profile', async () => {
    const send = vi.fn(async () => {
      throw new Error('Retry your request with the ID or ARN of an inference profile');
    });
    const llm = new BedrockLlm('us-east-1', 'global.anthropic.claude-haiku-5-5', undefined, { send } as never);
    await expect(llm.complete({ system: 's', prompt: 'p', maxTokens: 5 }, new ProviderContext())).rejects.toThrow('inference profile');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('structured answers', () => {
  it('forces the tool and returns its input', async () => {
    const send = vi.fn(async (_cmd: { input: Record<string, unknown> }) => ({
      output: { message: { content: [{ toolUse: { toolUseId: 't', name: 'arrange_days', input: { days: [{ day: 1, stopIds: ['a'], narrative: 'Say "hi".' }] } } }] } },
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const llm = new BedrockLlm('us-east-1', 'global.anthropic.claude-haiku-5-5', undefined, { send } as never);
    const out = await llm.completeJson({ system: 's', prompt: 'p', maxTokens: 50, name: 'arrange_days', schema: { type: 'object' } }, new ProviderContext());
    expect(out).toEqual({ days: [{ day: 1, stopIds: ['a'], narrative: 'Say "hi".' }] });
    const input = send.mock.calls[0][0].input as { toolConfig: { toolChoice: unknown }; inferenceConfig: Record<string, unknown> };
    expect(input.toolConfig.toolChoice).toEqual({ tool: { name: 'arrange_days' } });
    expect(input.inferenceConfig).not.toHaveProperty('temperature');
  });
});

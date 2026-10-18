import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { ProviderContext } from './infra.js';

/**
 * Language model via Amazon Bedrock (Converse API). Credentials come from the standard
 * AWS chain (env vars, profile, or an instance/task role). The model only arranges and
 * describes facts we pass in; it never supplies prices, times or places.
 */
export interface Llm {
  readonly enabled: boolean;
  complete(args: { system: string; prompt: string; maxTokens: number; fast?: boolean }, ctx: ProviderContext): Promise<string>;
}

/** Bedrock's reply when a model is only served through a cross-region inference profile. */
const NEEDS_PROFILE = /on-demand throughput isn.t supported|inference profile/i;
/** A bare model ID such as "anthropic.claude-haiku-5-5" (no "global."/"us." profile prefix). */
const isBareId = (id: string) => !id.startsWith('arn:') && !/^(global|us|eu|apac|au|jp|ca|us-gov)\./.test(id);

export class BedrockLlm implements Llm {
  private client?: Pick<BedrockRuntimeClient, 'send'>;
  /** Bare IDs that turned out to need the global profile, so later calls go straight there. */
  private readonly profiled = new Map<string, string>();

  constructor(
    private readonly region?: string,
    private readonly modelId?: string,
    private readonly fastModelId?: string,
    client?: Pick<BedrockRuntimeClient, 'send'>,
  ) {
    if (region && modelId) this.client = client ?? new BedrockRuntimeClient({ region });
  }

  get enabled() {
    return !!this.client;
  }

  async complete(args: { system: string; prompt: string; maxTokens: number; fast?: boolean }, ctx: ProviderContext): Promise<string> {
    if (!this.client) throw new Error('Bedrock is not configured (AWS_REGION + BEDROCK_MODEL_ID)');
    const configured = (args.fast && this.fastModelId) || this.modelId!;
    const send = (modelId: string) =>
      this.client!.send(
        new ConverseCommand({
          modelId,
          system: [{ text: args.system }],
          messages: [{ role: 'user', content: [{ text: args.prompt }] }],
          inferenceConfig: { maxTokens: args.maxTokens, temperature: 0.3 },
        }),
      );
    const modelId = this.profiled.get(configured) ?? configured;
    let res;
    try {
      res = await send(modelId);
    } catch (e) {
      // Newer Claude models (e.g. Haiku 5.5) have no in-region on-demand access: retry once
      // through the global cross-region profile, and remember it.
      const id = String(modelId);
      if (!isBareId(id) || !NEEDS_PROFILE.test((e as Error).message ?? '')) throw e;
      const viaGlobal = `global.${id}`;
      res = await send(viaGlobal);
      this.profiled.set(configured, viaGlobal);
    }
    ctx.recordTokens(res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0, configured === this.fastModelId);
    const text = (res.output?.message?.content ?? []).map((c) => ('text' in c ? c.text : '')).join('');
    if (!text) throw new Error(`Bedrock returned no text (stopReason ${res.stopReason})`);
    return text;
  }
}

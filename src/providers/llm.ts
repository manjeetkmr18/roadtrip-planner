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

export class BedrockLlm implements Llm {
  private client?: BedrockRuntimeClient;

  constructor(
    private readonly region?: string,
    private readonly modelId?: string,
    private readonly fastModelId?: string,
  ) {
    if (region && modelId) this.client = new BedrockRuntimeClient({ region });
  }

  get enabled() {
    return !!this.client;
  }

  async complete(args: { system: string; prompt: string; maxTokens: number; fast?: boolean }, ctx: ProviderContext): Promise<string> {
    if (!this.client) throw new Error('Bedrock is not configured (AWS_REGION + BEDROCK_MODEL_ID)');
    const modelId = (args.fast && this.fastModelId) || this.modelId!;
    const res = await this.client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: args.system }],
        messages: [{ role: 'user', content: [{ text: args.prompt }] }],
        inferenceConfig: { maxTokens: args.maxTokens, temperature: 0.3 },
      }),
    );
    ctx.recordTokens(res.usage?.inputTokens ?? 0, res.usage?.outputTokens ?? 0, modelId === this.fastModelId);
    const text = (res.output?.message?.content ?? []).map((c) => ('text' in c ? c.text : '')).join('');
    if (!text) throw new Error(`Bedrock returned no text (stopReason ${res.stopReason})`);
    return text;
  }
}

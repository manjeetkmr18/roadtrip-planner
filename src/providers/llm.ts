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
  /**
   * Structured reply: the model must answer through a tool with this JSON schema, so the result
   * is already parsed (no stray text or unescaped quotes to trip over).
   */
  completeJson?(args: { system: string; prompt: string; maxTokens: number; fast?: boolean; name: string; schema: Record<string, unknown> }, ctx: ProviderContext): Promise<unknown>;
}

type ConverseInput = ConstructorParameters<typeof ConverseCommand>[0];

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
    const res = await this.converse(args, {}, ctx);
    const text = (res.output?.message?.content ?? []).map((c) => ('text' in c ? c.text : '')).join('');
    if (!text) throw new Error(`Bedrock returned no text (stopReason ${res.stopReason})`);
    return text;
  }

  async completeJson(
    args: { system: string; prompt: string; maxTokens: number; fast?: boolean; name: string; schema: Record<string, unknown> },
    ctx: ProviderContext,
  ): Promise<unknown> {
    const res = await this.converse(
      args,
      {
        toolConfig: {
          tools: [{ toolSpec: { name: args.name, description: 'Return the answer.', inputSchema: { json: args.schema as never } } }],
          toolChoice: { tool: { name: args.name } },
        },
      },
      ctx,
    );
    const use = (res.output?.message?.content ?? []).find((c) => 'toolUse' in c && c.toolUse);
    if (!use || !('toolUse' in use) || !use.toolUse?.input) throw new Error(`Bedrock returned no structured answer (stopReason ${res.stopReason})`);
    return use.toolUse.input;
  }

  private async converse(args: { system: string; prompt: string; maxTokens: number; fast?: boolean }, extra: Partial<ConverseInput>, ctx: ProviderContext) {
    if (!this.client) throw new Error('Bedrock is not configured (AWS_REGION + BEDROCK_MODEL_ID)');
    const configured = (args.fast && this.fastModelId) || this.modelId!;
    const send = (modelId: string) =>
      this.client!.send(
        new ConverseCommand({
          modelId,
          system: [{ text: args.system }],
          messages: [{ role: 'user', content: [{ text: args.prompt }] }],
          // No temperature: newer Claude models reject it as deprecated.
          inferenceConfig: { maxTokens: args.maxTokens },
          ...extra,
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
    return res;
  }
}

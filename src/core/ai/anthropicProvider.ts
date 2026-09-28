import { env } from "../../lib/env";
import type { AiProvider } from "../providers/interfaces";
import { aiAnalysisSchema, type AiAnalysis, type AiInput } from "./schema";

const SYSTEM = `You are a market-analysis assistant inside a DEX trading research tool.
You receive structured quantitative and on-chain data about one low-cap token. You interpret it; you never decide or trigger trades.
Do not claim any token is safe. Do not promise profit. Use only the numbers provided.
Reply with ONE JSON object and nothing else, with exactly these keys:
whatIsHappening (string), whyInteresting (string), recentChanges (string),
strategyFit ({matches: boolean, explanation: string}), primaryRisks (string[]), invalidation (string[]).`;

/** Calls the Anthropic Messages API and validates the reply with Zod. Anything that fails validation is rejected. */
export class AnthropicAiProvider implements AiProvider {
  readonly name: string;
  readonly isLlm = true;

  constructor(private apiKey: string, private model: string) {
    this.name = `anthropic:${model}`;
  }

  async analyze(input: AiInput): Promise<AiAnalysis> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(input) }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`AI provider HTTP ${res.status}`);
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("AI response contained no JSON object");
    return aiAnalysisSchema.parse(JSON.parse(text.slice(start, end + 1)));
  }
}

export function aiConfigured(): boolean {
  return Boolean(env().AI_API_KEY);
}

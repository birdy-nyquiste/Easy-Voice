import type { LlmModel } from "./types";

/**
 * Calls are billed at a flat per-minute price whatever the model, so we only offer
 * models Telnyx recommends for assistants whose output price stays at or under this
 * (USD per 1M tokens). Unpriced models are skipped for the same reason.
 */
export const MAX_OUTPUT_PRICE_PER_M = 15;

export interface CatalogModel {
  id: string;
  recommended_for_assistants?: boolean;
  pricing?: { input?: string; output?: string; unit?: string };
}

export function toOfferedModels(catalog: CatalogModel[]): LlmModel[] {
  return catalog
    .flatMap((m) => {
      const input = Number(m.pricing?.input);
      const output = Number(m.pricing?.output);
      if (!m.recommended_for_assistants || m.pricing?.unit !== "1M_tokens") return [];
      if (!Number.isFinite(input) || !Number.isFinite(output) || output > MAX_OUTPUT_PRICE_PER_M) return [];
      return [{ id: m.id, name: modelName(m.id), inputPricePerM: input, outputPricePerM: output }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "moonshotai/Kimi-K2.6" → "Kimi-K2.6" */
function modelName(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}

/** Mock catalog: real Telnyx entries (verified 2026-10-08) so mock data matches live. */
export const MOCK_MODELS: CatalogModel[] = [
  { id: "moonshotai/Kimi-K2.6", recommended_for_assistants: true, pricing: { input: "0.665000", output: "4.000000", unit: "1M_tokens" } },
  { id: "zai-org/GLM-5.3-Flash", recommended_for_assistants: true, pricing: { input: "0.135000", output: "0.450000", unit: "1M_tokens" } },
  { id: "openai/gpt-5.4-mini", recommended_for_assistants: true, pricing: { input: "0.750000", output: "4.500000", unit: "1M_tokens" } },
  { id: "anthropic/claude-haiku-4-5", recommended_for_assistants: true, pricing: { input: "1.000000", output: "5.000000", unit: "1M_tokens" } },
  { id: "openai/gpt-5.6-sol", recommended_for_assistants: true, pricing: { input: "5.000000", output: "30.000000", unit: "1M_tokens" } },
  { id: "google/gemini-2.5-flash", recommended_for_assistants: true, pricing: {} },
  { id: "deepseek-ai/DeepSeek-V4-Flash-0731", recommended_for_assistants: false, pricing: { input: "0.13", output: "0.26", unit: "1M_tokens" } },
];

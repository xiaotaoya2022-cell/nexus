// 模型定价表（等效 API 费用估算用，美元 / 每百万 token）。
// 定价为公开牌价的近似值，UI 中明确标注"估算"；未命中按通用价处理。
// 口径与库内一致：input 不含缓存；cost = input*in + output*out + reasoning*out
//               + cacheRead*cacheRead + cacheWrite*input。

export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
}

const PRICING: Array<{ test: RegExp; price: ModelPrice }> = [
  { test: /claude.*(opus)/i, price: { input: 15, output: 75, cacheRead: 1.5 } },
  { test: /claude.*(haiku)/i, price: { input: 0.8, output: 4, cacheRead: 0.08 } },
  { test: /claude|codebuddy/i, price: { input: 3, output: 15, cacheRead: 0.3 } },
  { test: /gpt-5|codex|o3|o4/i, price: { input: 1.25, output: 10, cacheRead: 0.125 } },
  { test: /gpt-4o/i, price: { input: 2.5, output: 10, cacheRead: 1.25 } },
  { test: /gemini.*pro/i, price: { input: 1.25, output: 10, cacheRead: 0.31 } },
  { test: /gemini.*flash/i, price: { input: 0.15, output: 0.6, cacheRead: 0.0375 } },
  { test: /gemini/i, price: { input: 1.25, output: 10, cacheRead: 0.31 } },
  { test: /deepseek/i, price: { input: 0.27, output: 1.1, cacheRead: 0.027 } },
  { test: /glm|zai|chatglm/i, price: { input: 0.6, output: 2.2, cacheRead: 0.12 } },
  { test: /qwen/i, price: { input: 1.6, output: 6.4, cacheRead: 0.16 } },
  { test: /longcat/i, price: { input: 0.5, output: 2, cacheRead: 0.1 } },
  { test: /kimi|moonshot/i, price: { input: 0.6, output: 2.5, cacheRead: 0.12 } },
  { test: /llama/i, price: { input: 0.3, output: 0.6, cacheRead: 0.06 } }
]

const FALLBACK: ModelPrice = { input: 1, output: 3, cacheRead: 0.1 }

export function priceForModel(model: string): ModelPrice {
  for (const p of PRICING) {
    if (p.test.test(model)) return p.price
  }
  return FALLBACK
}

export function estimateCostUsd(
  model: string,
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
): number {
  const p = priceForModel(model)
  return (
    (tokens.input * p.input +
      (tokens.output + tokens.reasoning) * p.output +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheWrite * p.input) /
    1e6
  )
}

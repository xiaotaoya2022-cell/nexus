// 模型定价表（等效 API 费用估算用，美元 / 每百万 token）。
// 定价为公开牌价的近似值，UI 中明确标注"估算"；未命中按通用价处理。
// 支持用户配置币种（USD/CNY）、全局折扣倍率与自定义模型规则覆盖（如本地免费模型 / 自定义单价）。
// 口径与库内一致：input 不含缓存；cost = input*in + output*out + reasoning*out
//               + cacheRead*cacheRead + cacheWrite*input。

import { DEFAULT_PRICING_CONFIG, type PricingConfig, type PricingOverride } from '@shared/types'

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

function clampNum(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 规范化定价校准配置，确保类型安全且数值合理。
 */
export function normalizePricingConfig(raw: unknown): PricingConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const currency = obj.currency === 'CNY' ? 'CNY' : 'USD'
  const cnyRate = clampNum(obj.cnyRate, DEFAULT_PRICING_CONFIG.cnyRate, 0.01, 1000)
  const globalMultiplier = clampNum(obj.globalMultiplier, 1, 0, 100)
  const rawList = Array.isArray(obj.overrides) ? obj.overrides.slice(0, 64) : []
  const overrides: PricingOverride[] = []
  for (let idx = 0; idx < rawList.length; idx++) {
    const item = rawList[idx]
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const pattern = typeof r.pattern === 'string' ? r.pattern.trim().slice(0, 128) : ''
    if (!pattern) continue
    const mode = r.mode === 'free' || r.mode === 'multiplier' || r.mode === 'custom' ? r.mode : 'free'
    const clean: PricingOverride = {
      id: typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 64) : `ov_${idx + 1}`,
      pattern,
      mode
    }
    if (typeof r.label === 'string' && r.label.trim()) {
      clean.label = r.label.trim().slice(0, 64)
    }
    if (mode === 'multiplier') {
      clean.multiplier = clampNum(r.multiplier, 1, 0, 100)
    } else if (mode === 'custom') {
      clean.input = clampNum(r.input, 0, 0, 10000)
      clean.output = clampNum(r.output, 0, 0, 10000)
      clean.cacheRead = clampNum(r.cacheRead, 0, 0, 10000)
    }
    overrides.push(clean)
  }
  return { currency, cnyRate, globalMultiplier, overrides }
}

/**
 * 安全匹配模型规则（支持 `|` 分隔多条件、`*` 通配符或子串包含，无 ReDoS 风险）。
 */
export function matchesPricingPattern(model: string, pattern: string): boolean {
  const m = model.toLowerCase()
  const parts = pattern
    .split('|')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length === 0) return false
  return parts.some((part) => {
    if (!part.includes('*')) return m.includes(part)
    const collapsed = part.replace(/\*+/g, '*')
    const escaped = collapsed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`, 'i').test(model)
  })
}

function basePriceForModel(model: string): ModelPrice {
  for (const p of PRICING) {
    if (p.test.test(model)) return p.price
  }
  return FALLBACK
}

export function priceForModel(model: string, config?: PricingConfig): ModelPrice {
  const base = basePriceForModel(model)
  if (!config) return base

  for (const rule of config.overrides) {
    if (!matchesPricingPattern(model, rule.pattern)) continue
    if (rule.mode === 'free') return { input: 0, output: 0, cacheRead: 0 }
    if (rule.mode === 'custom') {
      return {
        input: rule.input ?? base.input,
        output: rule.output ?? base.output,
        cacheRead: rule.cacheRead ?? base.cacheRead
      }
    }
    const mult = rule.multiplier ?? 1
    return {
      input: base.input * mult,
      output: base.output * mult,
      cacheRead: base.cacheRead * mult
    }
  }

  const g = config.globalMultiplier
  if (g === 1) return base
  return {
    input: base.input * g,
    output: base.output * g,
    cacheRead: base.cacheRead * g
  }
}

export function estimateCostUsd(
  model: string,
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number },
  config?: PricingConfig
): number {
  const p = priceForModel(model, config)
  return (
    (tokens.input * p.input +
      (tokens.output + tokens.reasoning) * p.output +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheWrite * p.input) /
    1e6
  )
}

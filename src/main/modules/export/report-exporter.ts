// 报表导出引擎：基于 QueryService 聚合后的 BoardData 生成 CSV（UTF-8 BOM）、Markdown 与 JSON 报表。

import type { BoardData, PricingConfig, RangeKey } from '@shared/types'
import { estimateCostUsd } from '../aggregator/application/pricing'

export interface ExportContext {
  range: RangeKey
  agentLabel: string | null
  nodeLabel: string | null
  projectDir: string | null
  pricing: PricingConfig
  generatedAt?: number
}

function currencyFactor(pricing: PricingConfig): { symbol: string; code: string; factor: number } {
  return pricing.currency === 'CNY'
    ? { symbol: '¥', code: 'CNY', factor: pricing.cnyRate }
    : { symbol: '$', code: 'USD', factor: 1 }
}

function formatMoney(usd: number, pricing: PricingConfig): string {
  const { symbol, factor } = currencyFactor(pricing)
  const val = usd * factor
  if (val <= 0) return `${symbol}0.00`
  if (val < 0.01) return `${symbol}${val.toFixed(4)}`
  return `${symbol}${val.toFixed(2)}`
}

/**
 * CSV 单元格安全编码：中和 Excel 公式注入（以 = + - @ \t \r 开头加前导 '），并按 RFC 4180 转义引号与逗号。
 */
function csvCell(value: unknown): string {
  if (value == null) return ''
  let str = String(value)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',')
}

function mdCell(value: unknown): string {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function cacheHitPct(totals: BoardData['overview']['totals']): string {
  const denom = totals.input + totals.cacheRead + totals.cacheWrite
  if (denom <= 0) return '0.0%'
  return `${((totals.cacheRead / denom) * 100).toFixed(1)}%`
}

function isoTime(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return ''
  return new Date(ms).toISOString()
}

export function formatCsvReport(board: BoardData, ctx: ExportContext): string {
  const now = ctx.generatedAt ?? Date.now()
  const { code, factor } = currencyFactor(ctx.pricing)
  const lines: string[] = []

  lines.push(csvRow(['# Nexus AI Usage Report']))
  lines.push(csvRow(['GeneratedAt', new Date(now).toISOString()]))
  lines.push(csvRow(['Range', ctx.range]))
  lines.push(csvRow(['Node', ctx.nodeLabel ?? 'All Nodes']))
  lines.push(csvRow(['Agent', ctx.agentLabel ?? 'All Agents']))
  lines.push(csvRow(['ProjectFilter', ctx.projectDir ?? 'All Workspaces']))
  lines.push(csvRow(['Currency', code, 'GlobalMultiplier', ctx.pricing.globalMultiplier]))
  lines.push('')

  const t = board.overview.totals
  lines.push(csvRow(['[Overview]']))
  lines.push(
    csvRow([
      'TotalTokens',
      'Requests',
      'Input',
      'Output',
      'Reasoning',
      'CacheRead',
      'CacheWrite',
      'CacheHit',
      'Sessions',
      'ToolCalls',
      'ActiveModels',
      `EstimatedCost(${code})`
    ])
  )
  lines.push(
    csvRow([
      t.total,
      t.requests,
      t.input,
      t.output,
      t.reasoning,
      t.cacheRead,
      t.cacheWrite,
      cacheHitPct(t),
      board.overview.sessionCount,
      board.overview.toolCallCount,
      board.overview.activeModels,
      (t.estimatedCostUsd * factor).toFixed(4)
    ])
  )
  lines.push('')

  lines.push(csvRow(['[Workspaces / Projects]']))
  lines.push(
    csvRow(['WorkspaceName', 'ProjectDir', 'Tokens', 'Requests', 'Input', 'Output', 'CacheRead', `EstimatedCost(${code})`])
  )
  for (const p of board.byProject) {
    lines.push(
      csvRow([
        p.projectDir ? p.name : 'Default / Unassigned',
        p.projectDir ?? '',
        p.tokens,
        p.requests,
        p.input,
        p.output,
        p.cacheRead,
        (p.estimatedCostUsd * factor).toFixed(4)
      ])
    )
  }
  lines.push('')

  lines.push(csvRow(['[Models]']))
  lines.push(
    csvRow(['Model', 'Tokens', 'Requests', 'Input', 'Output', 'CacheRead', 'CacheWrite', `EstimatedCost(${code})`])
  )
  for (const m of board.byModel) {
    const mUsd = estimateCostUsd(
      m.name,
      {
        input: m.input,
        output: m.output,
        reasoning: Math.max(0, m.tokens - m.input - m.output - m.cacheRead - m.cacheWrite),
        cacheRead: m.cacheRead,
        cacheWrite: m.cacheWrite
      },
      ctx.pricing
    )
    lines.push(
      csvRow([
        m.name,
        m.tokens,
        m.requests,
        m.input,
        m.output,
        m.cacheRead,
        m.cacheWrite,
        (mUsd * factor).toFixed(4)
      ])
    )
  }
  lines.push('')

  lines.push(csvRow(['[Agents]']))
  lines.push(csvRow(['Agent', 'Tokens', 'Requests', 'Input', 'Output', 'CacheRead', 'CacheWrite']))
  for (const a of board.byAgent) {
    lines.push(csvRow([a.name, a.tokens, a.requests, a.input, a.output, a.cacheRead, a.cacheWrite]))
  }
  lines.push('')

  lines.push(csvRow(['[Sessions (Top 120)]']))
  lines.push(csvRow(['Agent', 'Node', 'SessionId', 'Title', 'ProjectDir', 'Model', 'Tokens', 'Requests', 'UpdatedAt']))
  for (const s of board.sessions) {
    lines.push(
      csvRow([
        s.agent,
        s.sourceNodeLabel ?? s.sourceNodeId ?? 'local',
        s.sessionId,
        s.title ?? '',
        s.projectDir ?? '',
        s.model ?? '',
        s.tokens,
        s.requests,
        isoTime(s.updatedAt ?? s.startedAt)
      ])
    )
  }

  return `\uFEFF${lines.join('\r\n')}`
}

export function formatMarkdownReport(board: BoardData, ctx: ExportContext): string {
  const now = ctx.generatedAt ?? Date.now()
  const t = board.overview.totals
  const { code } = currencyFactor(ctx.pricing)
  const lines: string[] = [
    '# Nexus AI Usage Report',
    '',
    `- **Generated**: ${new Date(now).toISOString()}`,
    `- **Range**: \`${ctx.range}\``,
    `- **Node**: ${ctx.nodeLabel ?? 'All Nodes'}`,
    `- **Agent**: ${ctx.agentLabel ?? 'All Agents'}`,
    `- **Workspace**: ${ctx.projectDir ?? 'All Workspaces'}`,
    `- **Currency / Multiplier**: ${code} (${ctx.pricing.globalMultiplier}x)`,
    '',
    '## Overview',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Total Tokens | ${t.total.toLocaleString('en-US')} |`,
    `| Requests | ${t.requests.toLocaleString('en-US')} |`,
    `| Sessions | ${board.overview.sessionCount.toLocaleString('en-US')} |`,
    `| Tool Calls | ${board.overview.toolCallCount.toLocaleString('en-US')} |`,
    `| Cache Hit Rate | ${cacheHitPct(t)} |`,
    `| Estimated Cost (${code}) | ${formatMoney(t.estimatedCostUsd, ctx.pricing)} |`,
    ''
  ]

  if (board.byProject.length > 0) {
    lines.push('## Workspaces / Projects (Top 15)', '')
    lines.push(`| Workspace | Path | Tokens | Requests | Est. Cost (${code}) |`)
    lines.push('| --- | --- | ---: | ---: | ---: |')
    for (const p of board.byProject.slice(0, 15)) {
      lines.push(
        `| ${mdCell(p.projectDir ? p.name : 'Default / Unassigned')} | ${mdCell(p.projectDir ?? '—')} | ${p.tokens.toLocaleString('en-US')} | ${p.requests.toLocaleString('en-US')} | ${formatMoney(p.estimatedCostUsd, ctx.pricing)} |`
      )
    }
    lines.push('')
  }

  if (board.byModel.length > 0) {
    lines.push('## Models (Top 15)', '')
    lines.push(`| Model | Tokens | Input | Output | Cache Read | Est. Cost (${code}) |`)
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const m of board.byModel.slice(0, 15)) {
      const mUsd = estimateCostUsd(
        m.name,
        {
          input: m.input,
          output: m.output,
          reasoning: Math.max(0, m.tokens - m.input - m.output - m.cacheRead - m.cacheWrite),
          cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite
        },
        ctx.pricing
      )
      lines.push(
        `| ${mdCell(m.name)} | ${m.tokens.toLocaleString('en-US')} | ${m.input.toLocaleString('en-US')} | ${m.output.toLocaleString('en-US')} | ${m.cacheRead.toLocaleString('en-US')} | ${formatMoney(mUsd, ctx.pricing)} |`
      )
    }
    lines.push('')
  }

  if (board.byAgent.length > 0) {
    lines.push('## Agents', '')
    lines.push('| Agent | Tokens | Requests |')
    lines.push('| --- | ---: | ---: |')
    for (const a of board.byAgent) {
      lines.push(`| ${mdCell(a.name)} | ${a.tokens.toLocaleString('en-US')} | ${a.requests.toLocaleString('en-US')} |`)
    }
    lines.push('')
  }

  if (board.sessions.length > 0) {
    lines.push('## Top Sessions (First 30)', '')
    lines.push('| Agent | Node | Title | Workspace | Tokens | Requests |')
    lines.push('| --- | --- | --- | --- | ---: | ---: |')
    for (const s of board.sessions.slice(0, 30)) {
      lines.push(
        `| ${mdCell(s.agent)} | ${mdCell(s.sourceNodeLabel ?? s.sourceNodeId ?? 'local')} | ${mdCell(s.title ?? s.sessionId)} | ${mdCell(s.projectDir ?? '—')} | ${s.tokens.toLocaleString('en-US')} | ${s.requests.toLocaleString('en-US')} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function formatJsonReport(board: BoardData, ctx: ExportContext): string {
  const now = ctx.generatedAt ?? Date.now()
  const { code, factor } = currencyFactor(ctx.pricing)
  const payload = {
    exportedAt: new Date(now).toISOString(),
    filter: {
      range: ctx.range,
      agent: ctx.agentLabel,
      node: ctx.nodeLabel,
      projectDir: ctx.projectDir
    },
    pricing: {
      currency: code,
      cnyRate: ctx.pricing.cnyRate,
      globalMultiplier: ctx.pricing.globalMultiplier,
      convertedTotalCost: Number((board.overview.totals.estimatedCostUsd * factor).toFixed(4))
    },
    overview: board.overview,
    byAgent: board.byAgent,
    byModel: board.byModel,
    byProject: board.byProject,
    tools: board.tools,
    sessions: board.sessions
  }
  return JSON.stringify(payload, null, 2)
}

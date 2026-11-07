// 厂商元数据与 Agent→厂商映射（侧栏"按厂商"视图 + 徽章用）。
// 颜色取各厂商品牌色的近似值；initial 为徽章内字符（中文厂商用单字）。

export interface VendorMeta {
  id: string
  label: string
  color: string
  initial: string
}

export const VENDORS: Record<string, VendorMeta> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', color: '#4D6BFE', initial: 'D' },
  openai: { id: 'openai', label: 'OpenAI', color: '#10A37F', initial: 'O' },
  anthropic: { id: 'anthropic', label: 'Anthropic', color: '#D97757', initial: 'A' },
  google: { id: 'google', label: 'Google', color: '#4285F4', initial: 'G' },
  tencent: { id: 'tencent', label: '腾讯', color: '#0052D9', initial: '腾' },
  alibaba: { id: 'alibaba', label: '阿里', color: '#FF6A00', initial: '阿' },
  bytedance: { id: 'bytedance', label: '字节', color: '#325AB4', initial: '字' },
  cursor: { id: 'cursor', label: 'Cursor', color: '#6E7681', initial: 'C' },
  zai: { id: 'zai', label: 'Z.ai', color: '#7C5CFF', initial: 'Z' },
  reasonix: { id: 'reasonix', label: 'Reasonix', color: '#F59E0B', initial: 'R' },
  xiaomi: { id: 'xiaomi', label: '小米', color: '#FF6900', initial: '米' },
  meta: { id: 'meta', label: 'Meta', color: '#0084FF', initial: 'M' },
  cline: { id: 'cline', label: 'Cline', color: '#3B82F6', initial: 'C' },
  roo: { id: 'roo', label: 'Roo Code', color: '#6366F1', initial: 'R' },
  kilo: { id: 'kilo', label: 'Kilo Code', color: '#F97316', initial: 'K' },
  oss: { id: 'oss', label: '开源', color: '#2EA043', initial: '开' }
}

/** agent id → 厂商 id。新增 Agent 时同步维护；未登记的回退通用徽章。 */
export const AGENT_VENDOR: Record<string, string> = {
  zcode: 'zai',
  codebuddy: 'tencent',
  dsh: 'deepseek',
  codex: 'openai',
  opencode: 'oss',
  mimo: 'xiaomi',
  muse: 'meta',
  workbuddy: 'tencent',
  reasonix: 'reasonix',
  antigravity: 'google',
  'claude-code': 'anthropic',
  cursor: 'cursor',
  qoder: 'alibaba',
  trae: 'bytedance',
  'gemini-cli': 'google',
  qwen: 'alibaba',
  cline: 'cline',
  'roo-code': 'roo',
  'kilo-code': 'kilo'
}

const FALLBACK: VendorMeta = { id: 'unknown', label: '其他', color: '#8B8D98', initial: '?' }

export function vendorOf(agentId: string): VendorMeta {
  const vid = AGENT_VENDOR[agentId]
  return (vid && VENDORS[vid]) || FALLBACK
}

// Agent 官方 logo（用户提供/官方图标，构建期打包离线可用）。
// Agent 行优先用本表；未收录的（dsh/workbuddy/trae/reasonix）回退厂商徽章。

import claudeCode from '@renderer/assets/agent-logos/claude-code.png'
import codebuddy from '@renderer/assets/agent-logos/codebuddy.png'
import codex from '@renderer/assets/agent-logos/codex.png'
import antigravity from '@renderer/assets/agent-logos/antigravity.png'
import cursor from '@renderer/assets/agent-logos/cursor.png'
import opencode from '@renderer/assets/agent-logos/opencode.png'
import qoder from '@renderer/assets/agent-logos/qoder.png'
import zcode from '@renderer/assets/agent-logos/zcode.png'

export const AGENT_LOGOS: Record<string, string> = {
  zcode,
  codebuddy,
  codex,
  'claude-code': claudeCode,
  antigravity,
  cursor,
  opencode,
  qoder
}

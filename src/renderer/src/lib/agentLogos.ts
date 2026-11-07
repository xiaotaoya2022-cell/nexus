// Agent 官方 logo（用户提供/官网抓取，构建期打包离线可用）。
// 映射已逐一与官网 favicon/logo 核对（2026-10-31）。
// Agent 行优先用本表；未收录的（dsh）回退厂商徽章。

import claudeCode from '@renderer/assets/agent-logos/claude-code.png'
import codebuddySvg from '@renderer/assets/agent-logos/codebuddy.svg'
import trae from '@renderer/assets/agent-logos/trae.png'
import codex from '@renderer/assets/agent-logos/codex.png'
import antigravity from '@renderer/assets/agent-logos/antigravity.png'
import cursor from '@renderer/assets/agent-logos/cursor.png'
import opencode from '@renderer/assets/agent-logos/opencode.png'
import qoder from '@renderer/assets/agent-logos/qoder.png'
import zcode from '@renderer/assets/agent-logos/zcode.png'
import workbuddySvg from '@renderer/assets/agent-logos/workbuddy.svg'
import reasonixSvg from '@renderer/assets/agent-logos/reasonix.svg'
import mimoPng from '@renderer/assets/agent-logos/mimo.png'
import museSvg from '@renderer/assets/agent-logos/muse.svg'
import clineSvg from '@renderer/assets/logos/cline.svg'
import geminiSvg from '@renderer/assets/agent-logos/googlegemini.svg'
import qwenSvg from '@renderer/assets/agent-logos/qwen.svg'

export const AGENT_LOGOS: Record<string, string> = {
  zcode,
  codebuddy: codebuddySvg,
  codex,
  'claude-code': claudeCode,
  antigravity,
  cursor,
  opencode,
  qoder,
  trae,
  workbuddy: workbuddySvg,
  reasonix: reasonixSvg,
  mimo: mimoPng,
  muse: museSvg,
  cline: clineSvg,
  'gemini-cli': geminiSvg,
  qwen: qwenSvg
}

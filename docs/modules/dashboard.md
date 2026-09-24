# dashboard 模块（渲染层）

> 最后更新：2026-09-25 02:42:39

## 结构

```
src/renderer/src/
├── styles/tokens.css      # 设计 Token（Zai Dark/Light，Tailwind v4 @theme inline）
├── store.ts               # zustand：range / agent / theme / sync
├── useDashboard.ts        # 数据 Hook：[range, agent, trendGroup] 全量拉取 + 同步广播自动刷新
├── charts/
│   ├── EChart.tsx         # ECharts 薄封装（init/dispose/ResizeObserver/onClick）
│   └── options.ts         # chartTokens()（CSS 变量→图表色）+ 各 option 工厂
├── components/            # ui.tsx（KPI卡/图表卡/药丸/状态灯/图标）、AgentSidebar、SessionsPanel
└── App.tsx                # 三栏布局与图表矩阵
```

## 关键实现决策

1. **主题先于取色**：`<html>` 的 theme class 在 `useLayoutEffect` 中落定，再以 `themeEpoch` 触发重渲染——保证 `chartTokens()` 读到的 CSS 变量与新主题一致（否则图表会拿着旧主题色画在新背景上）。
2. **ECharts 不解析 `color-mix()`**：热力五档色在 `chartTokens()` 内按主题直接给出 rgba 串（HEAT_DARK/HEAT_LIGHT）。
3. 趋势 Y 轴用 `fixedUnitFormatter` 按可见峰值统一单位（全 B 或全 M），避免 B/M 混排；折线 `smooth:false` 防样条视觉归零。
4. 模型排行条形按 Token 排名取色，与趋势折线图例同色，跨图同模型同色；工具排行单色。
5. 下钻交互：Agent 占比环形图点击扇区 → 全局 agent 筛选（再次点击取消）；左栏 Agent 项点击等效。
6. Agent 配色顺序：产出数据的 Agent 优先取前排色（组内按 id 字典序，跨刷新稳定）。
7. 图例/数值/时间戳一律 `font-mono tabular-nums`；轴刻度 10px、色 `--color-foreground-subtlest`；图内网格 `--color-hairline` 虚线弱于全局边框。
8. 空状态：虚线框 + 双行文案；同步中的只有数值变化才刷新对应图表（200ms 过渡，尊重 `prefers-reduced-motion`）。

## IPC 契约

`window.nexus`（preload contextBridge 暴露，类型见 `src/shared/types.ts` 的 `NexusApi`）。渲染层不直接触碰 Node/Electron API。

## 视觉验收辅助

- `NEXUS_CAPTURE=<png> [NEXUS_CAPTURE_DELAY_MS=n] [NEXUS_CAPTURE_SCROLL=bottom]`：启动、自动截图、退出（截图场景自动禁用 GPU 合成，避免 capturePage 图层伪影）。
- `NEXUS_DEBUG=1`：转发渲染进程 console / preload 错误 / 加载失败到主进程 stdout。

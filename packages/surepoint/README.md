# SurePoint

**为真实桌面与 Web 应用打造的、永不失联的物理自适应指针系统（Production-Ready Adaptive Pointer）。**

- **Zero-Dependency（零运行时依赖）**：纯 TypeScript + 原生 DOM/CSS，无 Framer Motion / GSAP 依赖，核心引擎框架无关（支持原生 Web、Electron、React、Vue、Svelte）。
- **原创核心机制——「自适应表现（Adaptive Presentation）」**：不止于颜色反转，而是覆盖视觉对比度、物理形态、性能功耗与异常恢复的四维自适应体系。

---

## 为什么是 SurePoint？

市面上已有的开源自定义光标大多面向营销展示页，放进真实高强度交互桌面软件或 SaaS 后台时常暴露三大硬伤：

| 维度 | 动效跟随型（如 Follower 类） | 混合反色型（如 `difference` 类） | **SurePoint** |
| --- | --- | --- | --- |
| **深浅背景适配** | 固定色，进深色顶栏/暗区域易隐身 | 遇 50% 中灰直接隐身，遇品牌色严重偏色 | **热点亮度滞回采样 + 双色护盾外描边**，全背景清晰 |
| **主线程卡顿安全** | 主线程卡死时指针一起“冻住” | 主线程卡死时指针一起“冻住” | **卡顿看门狗（>200ms 自动归还 OS 原生指针）** |
| **远控 / 注入兼容性** | `cursor: none` 触发远控软件强行回中 | `cursor: none` 触发远控软件强行回中 | **1×1 alpha=1 隐形像素 + 跳变退避与静默恢复** |
| **空闲能耗与体积** | 依赖动画库、常驻 rAF 空转 | 常驻渲染或需手动包区域组件 | **零依赖 + 静止 900ms 自动停帧休眠** |

---

## 快速开始

### 1. 框架无关 Core API（Vanilla JS / Vue / Electron / Svelte）

```ts
import { createSurePoint } from 'surepoint'
import 'surepoint/src/core/surepoint.css'

const pointer = createSurePoint({
  size: 12,
  onDegraded: () => console.info('Remote pointer jump detected, fell back to OS cursor.'),
  onRecovered: () => console.info('Continuous pointer restored.')
})

// 卸载清理
pointer.destroy()
```

### 2. React 集成

```tsx
import { SurePointCursor } from 'surepoint'
import 'surepoint/src/core/surepoint.css'

export function App() {
  return (
    <>
      <SurePointCursor size={12} />
      {/* Your app */}
    </>
  )
}
```

### 3. 对 `<canvas>` / 图片 / 复杂渐变显式声明区域极性（可选）

对于 DOM 样式无法直接读取背景像素的 `<canvas>` 图表或图片封面，可添加 `data-cursor-tone`：

```html
<div data-cursor-tone="dark">
  <!-- 深色背景区域，SurePoint 将自动切为瓷白态 + 深墨护盾 -->
</div>
```

---

## 资产包结构

```text
surepoint/
├── package.json
├── README.md
├── docs/
│   └── DESIGN_LANGUAGE.md      # 完整设计语言与工程规范文档
└── src/
    ├── index.ts                # 统一导出入口
    ├── core/
    │   ├── luminance.ts        # 热点 Alpha 合成亮度采样 + 滞回阈值判定
    │   ├── pointerEngine.ts    # 零依赖状态机、物理引擎、看门狗与远控退避
    │   └── surepoint.css       # 双色护盾、六态样式与 OS 隐形接管样式
    └── react/
        └── SurePointCursor.tsx # React 挂载组件与局部二阶弹簧预览垫
```

## License

MIT

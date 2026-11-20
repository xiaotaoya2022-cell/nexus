# SurePoint 设计语言规范（Adaptive Presentation Design Language）

> **设计核心**：指针是桌面软件与人之间最高频的触点。它应当像精密钢笔尖一样跟手、克制，并在任何底色、负载或网络远控环境下**永远清晰、永远可靠、永不失联**。

---

## 一、四维「自适应表现（Adaptive Presentation）」体系

### 1. 色彩与对比度自适应（Luminance-Aware Dual-Tone & Halo）

#### 为什么拒绝纯 `mix-blend-mode: difference`？
1. **50% 中灰隐身**：`difference(#ffffff, #808080) = #7f7f7f`，指针滑过中性灰控件/边框时几乎与背景融为一体。
2. **品牌色畸变**：蓝色按钮上反色会变成刺眼亮黄，破坏桌面工具冷静克制的视觉秩序。
3. **边缘割裂**：大尺寸交互环跨过按钮边缘时半截亮半截暗，视觉上宛如裁切故障。

#### SurePoint 解法：热点亮度采样 + 滞回区间 + 双色护盾
- **热点穿透采样**：通过 `elementsFromPoint(x, y)` 跳过指针自身，沿 DOM 堆叠执行 Porter-Duff `source-over` Alpha 合成，计算热点正下方的真实 WCAG 相对亮度 $L \in [0, 1]$（支持 `rgb/rgba` 与 CSS Color 4 `color(srgb ...)`）。
- **滞回区间防抖（Hysteresis）**：
  - 深墨态（浅底 `#0f172a`）→ 当 $L < 0.36$ 时切换为瓷白态；
  - 瓷白态（深底 `#f8fafc`）→ 当 $L > 0.44$ 时切换为深墨态；
  - 中间区间 `[0.36, 0.44]` 维持上一帧极性，配合 `120ms ease-out` 过渡，彻底杜绝边界抖动闪烁。
- **双色护盾外轮廓（Dual-Tone Halo）**：
  - 深墨态配 `1.25px rgba(255, 255, 255, 0.45)` 外护盾；
  - 瓷白态配 `1.25px rgba(15, 23, 42, 0.52)` 外护盾；
  - 交互空心环使用内外双侧微护盾，保证在任何复杂渐变或图表色块上依然保持可辨轮廓。

---

### 2. 形态与语义自适应（Six-State Pointer Machine）

| 状态 | 触发条件 | 尺寸与形变 | 跟随时间常数 |
| --- | --- | --- | --- |
| `default` | 常规浏览区域 | `size × size` 圆点 + 速度拉伸 | $\tau = 28\text{ms}$ |
| `interactive` | 中心或 12 点圆周采样命中可点击控件 | `2.5 × size` 空心包络环 | $\tau = 28\text{ms}$ |
| `text` | 命中可编辑输入框 / `[contenteditable]` | `2px × 20px` 衬线 I-beam | $\tau = 8\text{ms}$（高精度紧跟随） |
| `press` | `pointerdown` 按压期间 | 叠加 `scale(0.82)` 按压回弹 | 即时响应 |
| `leave / blur` | 指针离开窗口或失焦 | 停帧隐藏并释放原生指针 | — |
| `remote-degrade` | 连续跳变检测触发远控退避 | 归还系统光标，静默监听恢复 | — |

---

### 3. 物理动力学（Physics & Velocity Stretch）

- **全局指数追随**：帧率无关的指数阻尼 $x \leftarrow x + (x_t - x)\cdot(1 - e^{-\Delta t / \tau})$，在 60Hz / 120Hz / 240Hz 显示器上表现完全一致。
- **速度向量拉伸**：仅对 `default` 与 `interactive` 启用，拉伸比例 $\text{stretch} = \min(\|\vec{v}\| / 4000,\ 0.35)$，沿速度方向旋转并按 $(1 + \text{stretch},\ 1 - 0.5\cdot\text{stretch})$ 保持面积感。
- **局部预览真·二阶弹簧**：在设置页测试垫中使用二阶弹簧（刚度 $k = 320$、阻尼 $c = 26$），直观传达弹性阻尼手感。

---

### 4. 生产级护城河（Never-Lost Resilience）

1. **空闲休眠（Zero Idle Load）**：无按压且静止超过 `900ms`、速度收敛至 `< 0.05px/s` 时停止 `requestAnimationFrame`，主线程零空转。
2. **卡顿看门狗（Stall Watchdog）**：低频心跳检测主线程阻塞超过 `200ms` 时，立即移除隐形宿主类归还系统原生合成器光标，避免软件重载卡顿时鼠标“冻死”。
3. **远控兼容与跳变退避**：
   - 使用 1×1 `alpha=1` 极微像素 PNG 替代 `cursor: none`，保持 Win32 `CURSOR_SHOWING=1` 与有效 `hCursor`，防止远控软件误判为 FPS 锁鼠标而强行回中；
   - 基于连续原始指针位移判断 `> 400px` 跳变（`2s` 内达到 `3` 次自动退避归还系统光标；连续 `8s` 且 `>= 40` 次真实平滑移动后自动静默恢复）。

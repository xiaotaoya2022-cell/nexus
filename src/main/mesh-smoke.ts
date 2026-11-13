// Nexus Mesh Phase 2 端到端冒烟验证（不进 UI）：
// 模拟物理机 Hub 与同工作区共享的 Spoke 节点并发写入（含相同 sessionId 与 dedupeKey），
// 验证 nexus-pair:// 配对、增量水位线推流、跨节点聚合/单节点过滤、二次增量防重与节点移除。
// 运行：npx electron out/main/mesh-smoke.js

import { app, powerSaveBlocker } from 'electron'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parsePairUri } from '@shared/protocol'
import { NexusStore } from './modules/aggregator/infrastructure/store'
import { QueryService } from './modules/aggregator/application/query-service'
import { SystemCollector } from './modules/system/collector'
import { RemoteServer } from './modules/remote/server'
import { ZcodeManager } from './modules/zcode/manager'
import { DshBridge } from './modules/dsh/bridge'
import { NodeIdentityService } from './modules/mesh/identity'
import { MeshClient } from './modules/mesh/client'
import { MeshService } from './modules/mesh/service'

function cleanupDb(dbPath: string): void {
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
}

async function main(): Promise<void> {
  const blocker = powerSaveBlocker.start('prevent-app-suspension')
  const stamp = `${process.pid}-${Date.now()}`
  const tmpDir = app.getPath('temp')
  const hubDbPath = join(tmpDir, `nexus-mesh-hub-${stamp}.db`)
  const spokeDbPath = join(tmpDir, `nexus-mesh-spoke-${stamp}.db`)
  const hubUserDataDir = join(tmpDir, `nexus-mesh-hub-ud-${stamp}`)

  cleanupDb(hubDbPath)
  cleanupDb(spokeDbPath)
  rmSync(hubUserDataDir, { recursive: true, force: true })
  mkdirSync(hubUserDataDir, { recursive: true })

  let hubStore: NexusStore | null = null
  let spokeStore: NexusStore | null = null
  let hubRemote: RemoteServer | null = null
  let hubClient: MeshClient | null = null
  let spokeClient: MeshClient | null = null

  try {
    hubStore = new NexusStore(hubDbPath)
    spokeStore = new NexusStore(spokeDbPath)

    const testPort = 28000 + (process.pid % 10000)
    hubStore.setSetting('remotePort', String(testPort))

    const hubIdentity = new NodeIdentityService(hubStore)
    hubIdentity.setAlias('Hub-Host')
    hubIdentity.setRoleOverride('hub')

    const spokeIdentity = new NodeIdentityService(spokeStore)
    spokeIdentity.setAlias('VM-Worker')

    const hubQuery = new QueryService(hubStore, () => hubIdentity.nodeId)
    const hubSystem = new SystemCollector()
    const spokeSystem = new SystemCollector()

    hubRemote = new RemoteServer(
      {
        store: hubStore,
        query: hubQuery,
        system: hubSystem,
        zcode: new ZcodeManager(),
        dsh: new DshBridge(),
        userDataDir: hubUserDataDir,
        identity: hubIdentity,
        getActiveAgents: () => ['claude-code', 'opencode'],
        onMeshChanged: () => hubQuery.invalidateBoardCache()
      },
      'mesh-smoke-secret'
    )

    hubClient = new MeshClient(hubStore, hubIdentity, hubSystem, () => ['claude-code', 'opencode'])
    const hubMesh = new MeshService({
      store: hubStore,
      identity: hubIdentity,
      system: hubSystem,
      remote: hubRemote,
      client: hubClient,
      getActiveAgents: () => ['claude-code', 'opencode'],
      onInvalidateBoard: () => hubQuery.invalidateBoardCache()
    })

    spokeClient = new MeshClient(spokeStore, spokeIdentity, spokeSystem, () => ['claude-code'])

    // 在同一工作区 F:\Nexus 下写入相同 sessionId 与 dedupeKey 的并发记录
    const now = Date.now()
    hubStore.insertUsage([
      {
        agent: 'claude-code',
        model: 'claude-sonnet-4-5',
        provider: null,
        ts: now - 5_000,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionId: 'shared-sess-1',
        dedupeKey: 'shared-dedupe-1'
      }
    ])
    hubStore.upsertSessions([
      {
        agent: 'claude-code',
        sessionId: 'shared-sess-1',
        title: 'Hub Session Title',
        projectDir: 'F:\\Nexus',
        model: 'claude-sonnet-4-5',
        startedAt: now - 10_000,
        updatedAt: now - 5_000
      }
    ])

    spokeStore.insertUsage([
      {
        agent: 'claude-code',
        model: 'claude-sonnet-4-5',
        provider: null,
        ts: now - 4_000,
        inputTokens: 2000,
        outputTokens: 800,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionId: 'shared-sess-1',
        dedupeKey: 'shared-dedupe-1'
      }
    ])
    spokeStore.upsertSessions([
      {
        agent: 'claude-code',
        sessionId: 'shared-sess-1',
        title: 'Spoke Initial Title',
        projectDir: 'F:\\Nexus',
        model: 'claude-sonnet-4-5',
        startedAt: now - 9_000,
        updatedAt: now - 4_000
      }
    ])
    spokeStore.insertToolCalls([
      {
        agent: 'claude-code',
        toolName: 'Bash',
        ts: now - 3_500,
        sessionId: 'shared-sess-1',
        dedupeKey: 'shared-tool-1'
      }
    ])

    // Hub 自动启用远控端口并生成配对串，Spoke 配对连入并首轮全量增量推流
    const pairing = await hubRemote.regeneratePairing()
    assert(pairing.addresses.length >= 1, 'pairing addresses should not be empty')
    const bound = parsePairUri(pairing.addresses[0].uri)
    const loopbackUri = `nexus-pair://127.0.0.1:${bound.port}?n=${pairing.nonce}&s=${pairing.pairingSecret}#${pairing.pin}`

    await spokeClient.pairWithHub({ uri: loopbackUri })
    assert.equal(spokeIdentity.getEffectiveRole(), 'spoke')

    const status = await hubMesh.getStatus()
    assert.equal(status.localNode.nodeId, hubIdentity.nodeId)
    assert.equal(status.localNode.role, 'hub')
    const spokeNode = status.nodes.find((n) => n.nodeId === spokeIdentity.nodeId)
    assert(spokeNode, 'Hub status should include paired Spoke node')
    assert.equal(spokeNode.status, 'online')
    assert(spokeNode.hwSummary && typeof spokeNode.hwSummary.cpuCores === 'number')
    assert(spokeNode.ackedWatermark.usageId >= 1)
    assert(spokeNode.ackedWatermark.sessionSeq >= 1)
    assert(spokeNode.ackedWatermark.toolId >= 1)
    assert.equal(spokeNode.totalTokens, 2800)

    // 验证跨节点合并查询 & 按 nodeId 精确过滤
    const qNow = Date.now()
    const allBoard = hubQuery.getBoard('7d', null, qNow, undefined, null)
    assert.equal(allBoard.overview.totals.total, 4300)
    assert.equal(allBoard.overview.sessionCount, 2)
    assert.equal(allBoard.overview.toolCallCount, 1)

    const allSessions = hubQuery.getSessions('7d', null, 20, qNow, null)
    assert.equal(allSessions.length, 2)
    const hubSess = allSessions.find((s) => s.sourceNodeId === hubIdentity.nodeId)
    const spokeSess = allSessions.find((s) => s.sourceNodeId === spokeIdentity.nodeId)
    assert(hubSess && hubSess.sourceNodeLabel === 'Hub-Host' && hubSess.title === 'Hub Session Title')
    assert(spokeSess && spokeSess.sourceNodeLabel === 'VM-Worker' && spokeSess.title === 'Spoke Initial Title')

    const hubOnlyBoard = hubQuery.getBoard('7d', null, qNow, undefined, hubIdentity.nodeId)
    assert.equal(hubOnlyBoard.overview.totals.total, 1500)
    assert.equal(hubOnlyBoard.overview.sessionCount, 1)
    assert.equal(hubOnlyBoard.overview.toolCallCount, 0)

    const spokeOnlyBoard = hubQuery.getBoard('7d', null, qNow, undefined, spokeIdentity.nodeId)
    assert.equal(spokeOnlyBoard.overview.totals.total, 2800)
    assert.equal(spokeOnlyBoard.overview.sessionCount, 1)
    assert.equal(spokeOnlyBoard.overview.toolCallCount, 1)

    // 验证第二次增量同步：新增用量 + 更新已有会话标题，严禁重复累加首批记录
    const wmBefore = spokeClient.loadWatermark()
    spokeStore.insertUsage([
      {
        agent: 'claude-code',
        model: 'claude-sonnet-4-5',
        provider: null,
        ts: qNow,
        inputTokens: 200,
        outputTokens: 100,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessionId: 'shared-sess-1',
        dedupeKey: 'spoke-usage-2'
      }
    ])
    spokeStore.upsertSessions([
      {
        agent: 'claude-code',
        sessionId: 'shared-sess-1',
        title: 'Spoke Updated Title',
        projectDir: 'F:\\Nexus',
        model: 'claude-sonnet-4-5',
        startedAt: now - 9_000,
        updatedAt: qNow
      }
    ])

    const push2 = await spokeClient.syncDelta()
    assert(push2.pushed >= 2)
    assert(push2.watermark.usageId > wmBefore.usageId)
    assert(push2.watermark.sessionSeq > wmBefore.sessionSeq)

    const allBoardAfter = hubQuery.getBoard('7d', null, Date.now(), undefined, null)
    assert.equal(allBoardAfter.overview.totals.total, 4600)
    assert.equal(allBoardAfter.overview.sessionCount, 2)

    const spokeSessionsAfter = hubQuery.getSessions('7d', null, 20, Date.now(), spokeIdentity.nodeId)
    assert.equal(spokeSessionsAfter.length, 1)
    assert.equal(spokeSessionsAfter[0].title, 'Spoke Updated Title')

    // 断开后移除远端节点，验证 Hub 数据干净回落到本机口径
    spokeClient.stop()
    const afterRemove = await hubMesh.removeNode(spokeIdentity.nodeId)
    assert.equal(afterRemove.nodes.length, 1)
    const boardAfterRemove = hubQuery.getBoard('7d', null, Date.now(), undefined, null)
    assert.equal(boardAfterRemove.overview.totals.total, 1500)
    assert.equal(boardAfterRemove.overview.sessionCount, 1)

    console.log(
      `[mesh-smoke] PASS hub=${hubIdentity.nodeId} spoke=${spokeIdentity.nodeId} port=${bound.port} pushed2=${push2.pushed}`
    )
  } finally {
    spokeClient?.stop()
    hubClient?.stop()
    hubRemote?.stop()
    hubStore?.close()
    spokeStore?.close()
    cleanupDb(hubDbPath)
    cleanupDb(spokeDbPath)
    rmSync(hubUserDataDir, { recursive: true, force: true })
    powerSaveBlocker.stop(blocker)
  }
}

void app.whenReady().then(() => {
  main()
    .then(() => app.exit(0))
    .catch((err) => {
      console.error('[mesh-smoke] FAIL', err)
      app.exit(1)
    })
})

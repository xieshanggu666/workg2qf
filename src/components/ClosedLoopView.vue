<script setup>
import { ref, computed } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const tab = ref('forecast')

const tabs = [
  { k: 'forecast', label: '统一客流预测' },
  { k: 'dispatch', label: '缺口与优先级' },
  { k: 'reconcile', label: '一致性巡检' }
]

const today = computed(() => store.clock.day)
const loop = computed(() => store.closedLoop)
const dayName = d => d === today.value ? '今天' : d === today.value + 1 ? '明天' : d === today.value + 2 ? '后天' : `第${d}天`
const selectedDay = ref(0)   // 0/1/2

const dayRows = computed(() => loop.value.days || [])
const activeDay = computed(() => dayRows.value[selectedDay.value] || dayRows.value[0])

const pct = (v, max) => Math.max(2, Math.min(100, Math.round((v / Math.max(1, max)) * 100)))
const maxHourFlow = computed(() => Math.max(1, ...(activeDay.value?.forecast?.hours || []).map(h => h.flow)))

const bandColor = { morning: '#66a6ff', mid: '#6dd5a0', evening: '#a78bfa', night: '#ff9e64' }
const bandName = { morning: '早班 9~14', mid: '中班 12~17', evening: '晚班 14~18', night: '跨日夜班' }

// 合并在途检修工单 + 在途投诉，按统一优先级排序（资源调度先后依据）
const priorityList = computed(() => {
  const orders = store.maintenanceOrders.filter(o => ['queued', 'processing'].includes(o.status)).map(o => ({
    kind: 'maintenance', code: o.code, title: `检修工单 · ${o.ride_name}`,
    status: o.status === 'processing' ? '检修中' : '排队待接',
    priority: (o.status === 'processing' ? 70 : 50) + Math.round((100 - (o.progress || 0)) / 10),
    detail: `进度 ${Math.round(o.progress || 0)}%${o.assignee_name ? ` · ${o.assignee_name}` : ''}`
  }))
  const comps = store.complaints.filter(c => ['open', 'processing', 'ready'].includes(c.status)).map(c => {
    const t = Number(store.clock.tick)
    const sevBase = { 1: 30, 2: 55, 3: 85 }[c.severity] || 30
    const sla = (c.deadline_tick || 0) - t
    const slaScore = c.status === 'open'
      ? Math.max(0, Math.min(30, 30 - Math.max(0, sla) * 2)) + (sla < 0 ? 15 : 0)
      : c.status === 'processing' ? 12 : 6
    return {
      kind: 'complaint', code: c.code, title: `${c.category_name || ''} · ${c.title || ''}`,
      status: c.status === 'open' ? '待受理' : c.status === 'processing' ? '处置中' : '待补偿结案',
      priority: sevBase + slaScore + (c.escalated ? 8 : 0),
      detail: `${c.severity_name || ''}${sla < 0 ? ' · 已超时' : ` · 剩余 ${sla}h`}${c.assignee_name ? ` · ${c.assignee_name}` : ''}`
    }
  })
  return [...orders, ...comps].sort((a, b) => b.priority - a.priority).slice(0, 30)
})

// 巡检告警
const findings = computed(() => store.reconcileList || [])
const reconcileStat = computed(() => loop.value.reconcile || { open: 0, blocks: 0 })
const kindMeta = {
  slot_counter: { name: '库存计数器漂移', healable: true },
  finance_refund: { name: '退款资金流水缺失', healable: false },
  group_ledger: { name: '团账流水不平', healable: false },
  attendance: { name: '考勤未结算', healable: false },
  schedule_conflict: { name: '跨日排班冲突', healable: false }
}

const running = ref(false)
async function runCheck() {
  running.value = true
  await store.runReconcile(true)
  running.value = false
}
async function ignoreOne(f) {
  if (!confirm(`忽略告警 ${f.code}？（确认已人工核对无误）`)) return
  await store.ignoreReconcile(f.id)
}
async function goDispatch() {
  const r = await store.runDispatch({ reason: '闭环看板手动触发统一调度' })
  if (r?.ok) alert(`动态补位 ${r.created?.length || 0} 个排班，紧急加班调令 ${r.otRequests?.length || 0} 条待主管审批`)
  else alert(r?.msg || '调度未执行')
}
</script>

<template>
  <div class="grid g-loop">
    <!-- 顶部指标条 -->
    <div class="card kpis">
      <div class="kpi">
        <div class="muted">外推学习系数</div>
        <div class="big">{{ loop.forecast?.factor ?? 1 }}</div>
        <div class="muted small">散客预测自适应（0.6~1.6）</div>
      </div>
      <div class="kpi">
        <div class="muted">近 3 日预测命中率</div>
        <div class="big">{{ loop.forecast?.avgAccuracy == null ? '—' : loop.forecast.avgAccuracy + '%' }}</div>
        <div class="muted small">日结按实际客流回填学习</div>
      </div>
      <div class="kpi">
        <div class="muted">待确认团单置信</div>
        <div class="big">{{ Math.round((loop.forecast?.pendingGroupsConfidence ?? 0.7) * 100) }}%</div>
        <div class="muted small">未确认名额折算计入预测</div>
      </div>
      <div class="kpi" :class="{ alert: reconcileStat.blocks > 0 }">
        <div class="muted">巡检未闭环</div>
        <div class="big">{{ reconcileStat.open ?? 0 }}</div>
        <div class="muted small">严重 {{ reconcileStat.blocks ?? 0 }} 项</div>
      </div>
      <button class="primary" :disabled="running" @click="runCheck">{{ running ? '巡检中…' : '立即一致性巡检' }}</button>
    </div>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.label }}</button>
    </div>

    <!-- 统一客流预测 -->
    <template v-if="tab === 'forecast'">
      <div class="card">
        <h3>📈 未来 3 天统一客流预测（预约 + 团队 + 会员 + 散客外推）</h3>
        <div class="day-tabs">
          <button v-for="(d, i) in dayRows" :key="d.day" :class="{ on: selectedDay === i }" @click="selectedDay = i">
            {{ dayName(d.day) }} · 第{{ d.day }}天
            <b>{{ d.forecast.predictedFlow.toLocaleString() }}</b> 人
          </button>
        </div>

        <div v-if="activeDay" class="fc-body">
          <div class="fc-summary">
            <span><em class="dot" style="background:#66a6ff"></em>入园预约 {{ activeDay.forecast.reserveEntry.toLocaleString() }}</span>
            <span><em class="dot" style="background:#a78bfa"></em>其中团队 {{ activeDay.forecast.groupEntry.toLocaleString() }}</span>
            <span><em class="dot" style="background:#6dd5a0"></em>会员预约 {{ activeDay.forecast.memberEntry.toLocaleString() }}</span>
            <span><em class="dot" style="background:#ffd166"></em>设施折算 {{ activeDay.forecast.reserveRide.toLocaleString() }}</span>
            <span><em class="dot" style="background:#8b93ad"></em>散客外推 {{ activeDay.forecast.walkinForecast.toLocaleString() }}</span>
          </div>
          <div class="bars">
            <div v-for="h in activeDay.forecast.hours" :key="h.hour" class="bar-col" :title="`${h.hour}:00 预测 ${h.flow} 人（入园预约 ${h.entry} / 团队 ${h.groupEntry} / 设施折算 ${h.ride} / 散客 ${h.walkin}）`">
              <div class="bar">
                <div class="seg ride" :style="{ height: pct(h.ride, maxHourFlow) + '%' }"></div>
                <div class="seg reserve" :style="{ height: pct(h.entry, maxHourFlow) + '%' }"></div>
                <div class="seg walkin" :style="{ height: pct(h.walkin, maxHourFlow) + '%' }"></div>
              </div>
              <label>{{ h.hour }}</label>
            </div>
          </div>
          <div class="legend muted small">
            堆叠：散客外推（灰）+ 入园预约含团队/会员（蓝）+ 设施预约折算（黄）；悬停查看构成。预测快照每小时随库存/退款/团单变化自动刷新，事务回滚不会驱动重排。
          </div>
        </div>
      </div>
    </template>

    <!-- 缺口与优先级 -->
    <template v-else-if="tab === 'dispatch'">
      <div class="card">
        <h3>🛠️ 检修 / 投诉统一优先级队列（动态调度与紧急调令据此先后补位）</h3>
        <div class="pri-list">
          <div v-for="(p, i) in priorityList" :key="p.kind + p.code" class="pri-row" :class="p.kind">
            <span class="rank">#{{ i + 1 }}</span>
            <span class="score" :class="{ hot: p.priority >= 100 }">{{ p.priority }}</span>
            <span class="pkind">{{ p.kind === 'maintenance' ? '🔧 检修' : '📨 投诉' }}</span>
            <span class="ptitle">{{ p.code }} · {{ p.title }}</span>
            <span class="muted small">{{ p.detail }}</span>
            <span class="tag">{{ p.status }}</span>
          </div>
          <div v-if="!priorityList.length" class="muted">当前无在途检修工单或待处置投诉。</div>
        </div>
      </div>

      <div class="card">
        <h3>🗓️ 班段 × 岗位需求（统一预测折算；跨日夜班含闭园前 17:00 客流兜底）
          <button class="primary mini" @click="goDispatch">一键动态补位</button>
        </h3>
        <div class="band-grid">
          <div v-for="d in dayRows" :key="d.day" class="band-day">
            <div class="bd-title">{{ dayName(d.day) }} · 第{{ d.day }}天</div>
            <div v-for="b in d.demand.bands" :key="b.key" class="band-card" :style="{ borderColor: bandColor[b.key] }">
              <div class="bc-head"><span :style="{ color: bandColor[b.key] }">{{ bandName[b.key] }}</span><span class="muted small">{{ bandName[b.key].includes('跨日') ? '17:00~次日9:00' : '' }}</span></div>
              <div class="needs">
                <span>保安 <b>{{ b.need_guard }}</b></span>
                <span>保洁 <b>{{ b.need_clean }}</b></span>
                <span>维修 <b>{{ b.need_repair }}</b></span>
              </div>
              <div class="muted small">客流 {{ b.flow.toLocaleString() }} / 峰值 {{ b.peak.toLocaleString() }}</div>
              <div v-if="b.orders.length" class="why">🔧 {{ b.orders.map(o => o.code).join('、') }}</div>
              <div v-if="b.complaints.length" class="why">📨 {{ b.complaints.slice(0, 3).map(c => c.code).join('、') }}<span v-if="b.complaints.length > 3"> 等{{ b.complaints.length }}</span></div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 一致性巡检 -->
    <template v-else>
      <div class="card">
        <h3>🔍 闭环一致性巡检（排班 / 预约 / 库存 / 团账 / 财务）
          <button class="primary mini" :disabled="running" @click="runCheck">{{ running ? '巡检中…' : '重新巡检' }}</button>
        </h3>
        <div class="muted small intro">
          每小时引擎自动巡检：时段库存计数器漂移会按预约单事实源<strong>自动校正</strong>（仅改计数、不动资金）；
          退款流水缺失、团账不平、考勤漏结、跨日夜班次日硬冲突只告警不擅改，需人工核对，避免排班、预约与财务状态不一致。
        </div>
        <table class="t">
          <thead><tr><th>单号</th><th>类型</th><th>级别</th><th>问题</th><th>详情</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="f in findings" :key="f.id">
              <td>{{ f.code }}</td>
              <td>{{ kindMeta[f.kind]?.name || f.kind }}</td>
              <td><span class="tag" :class="f.level === 'block' ? 'blk' : 'wrn'">{{ f.level === 'block' ? '严重' : '预警' }}</span></td>
              <td>{{ f.title }}</td>
              <td class="muted small">{{ f.detail }}</td>
              <td><span class="tag" :class="f.status === 'healed' ? 'ok' : ''">{{ f.status === 'healed' ? '已自愈' : '待处理' }}</span></td>
              <td><button v-if="f.status === 'open'" class="mini" @click="ignoreOne(f)">忽略</button></td>
            </tr>
            <tr v-if="!findings.length"><td colspan="7" class="muted">巡检通过，未发现排班/预约/财务口径不一致。</td></tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.g-loop { gap: 14px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 14px; align-items: center; }
.kpi .big { font-size: 24px; font-weight: 800; }
.kpi.alert .big { color: var(--red); }
.small { font-size: 12px; }
.tabs { display: flex; gap: 8px; }
.tabs button, .day-tabs button { background: var(--panel); border: 1px solid var(--border); color: var(--muted); padding: 8px 14px; border-radius: 10px; cursor: pointer; }
.tabs button.on { color: var(--accent); border-color: var(--accent); }
.day-tabs { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.day-tabs button.on { background: var(--panel2); color: var(--text); border-color: var(--blue); }
.day-tabs b { color: var(--green); margin-left: 6px; }
.fc-summary { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; font-size: 13px; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
.bars { display: flex; gap: 6px; align-items: flex-end; height: 200px; padding: 8px 4px 0; border-bottom: 1px solid var(--border); }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bar { width: 70%; display: flex; flex-direction: column-reverse; justify-content: flex-start; }
.seg { width: 100%; }
.seg.reserve { background: var(--blue); }
.seg.ride { background: var(--accent2); }
.seg.walkin { background: #5a6380; }
.bar-col label { font-size: 11px; color: var(--muted); margin-top: 5px; }
.legend { margin-top: 10px; line-height: 1.6; }
.pri-list { display: flex; flex-direction: column; gap: 8px; }
.pri-row { display: flex; align-items: center; gap: 12px; padding: 9px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; }
.pri-row .rank { color: var(--muted); width: 28px; }
.pri-row .score { font-weight: 800; font-size: 16px; width: 40px; color: var(--accent2); }
.pri-row .score.hot { color: var(--red); }
.pri-row.complaint .score { color: var(--purple); }
.pkind { width: 64px; font-size: 12px; }
.ptitle { flex: 1; }
.mini { padding: 4px 12px; font-size: 12px; }
h3 button { margin-left: auto; }
.band-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 14px; }
.bd-title { font-weight: 700; margin-bottom: 8px; }
.band-card { border: 1px solid var(--border); border-left-width: 3px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; background: var(--panel2); }
.bc-head { display: flex; justify-content: space-between; font-weight: 600; margin-bottom: 6px; }
.needs { display: flex; gap: 14px; margin-bottom: 4px; }
.needs b { color: var(--text); }
.why { font-size: 12px; color: var(--accent2); margin-top: 3px; }
.t { width: 100%; border-collapse: collapse; font-size: 13px; }
.t th, .t td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.t th { color: var(--muted); font-weight: 500; }
.tag.blk { color: var(--red); border-color: rgba(255,107,107,.5); }
.tag.wrn { color: var(--accent2); }
.tag.ok { color: var(--green); border-color: rgba(109,213,160,.5); }
.intro { line-height: 1.7; margin-bottom: 12px; }
</style>

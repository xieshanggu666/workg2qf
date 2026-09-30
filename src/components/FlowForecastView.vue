<script setup>
import { ref, computed, onMounted } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const tab = ref('forecast')
const audit = ref(null)
const busy = ref(false)
const msg = ref(null)

const today = computed(() => store.clock.day)
const plan = computed(() => store.flowPlan)
const stats = computed(() => store.flowStats)
const reconcile = computed(() => store.reconcile)

const DAY_LABELS = ['今天', '明天', '后天']

function maxFlow(day) {
  return Math.max(1, ...day.hours.map(h => h.flow))
}
function barWidth(h, day) {
  return Math.round(Math.max(2, h.flow / maxFlow(day) * 100))
}
function barSegments(h) {
  // 预约三类（散约/会员/团单）+ 散客 + 设施压力，按比例堆叠
  const reserved = h.guest_reserved + h.member_reserved + h.group_reserved
  const total = Math.max(1, h.flow)
  return [
    { k: 'walkin', name: '散客在园', v: h.walkin, color: '#5b8def' },
    { k: 'guest', name: '散客预约', v: h.guest_reserved, color: '#38bdf8' },
    { k: 'member', name: '会员预约', v: h.member_reserved, color: '#a78bfa' },
    { k: 'group', name: '团单名额', v: h.group_reserved, color: '#fbbf24' },
    { k: 'ride', name: '设施折算', v: h.ride_pressure, color: '#fb7185' }
  ].filter(s => s.v > 0).map(s => ({ ...s, pct: Math.round(s.v / total * 100) }))
}

const bandName = { morning: '早班 9-12', mid: '中班 12-14', evening: '晚班 14-18', night: '夜班' }
function bandNeed(b) {
  // 与排班阈值同源的需求人数由调度接口给出，这里仅展示客流压力
  return b
}

async function loadAudit() {
  busy.value = true
  try { audit.value = await store.reconcileAudit() } finally { busy.value = false }
}
async function repair(only) {
  msg.value = null
  const label = only ? ({ slots: '库存计数', pending: '补退挂起', groups: '团账汇总' }[only]) : '全部'
  if (!window.confirm(`确认执行「${label}」一致性修复？\n将以单据/流水为准重算派生计数与汇总，不改动任何现金与逐条财务流水。`)) return
  busy.value = true
  try {
    const r = await store.reconcileRepair(only)
    if (r?.ok) {
      msg.value = { ok: true, text: `修复完成：时段 ${r.fixedSlots ?? 0} 处、挂起作废 ${r.obsoletePending ?? 0} 条、团账 ${r.fixedGroups ?? 0} 个` }
      audit.value = { audit: r.audit, stats: r.stats }
    } else {
      msg.value = { ok: false, text: `${r?.msg || '修复失败'}${r?.code ? `〔${r.code}${r.reqId ? ' · ' + r.reqId : ''}〕` : ''}` }
    }
  } finally { busy.value = false }
}
async function refresh() {
  busy.value = true
  try { await store.refreshFlowForecast() } finally { busy.value = false }
}
onMounted(loadAudit)
</script>

<template>
  <div class="wrap">
    <div class="tabs">
      <button :class="{ on: tab === 'forecast' }" @click="tab = 'forecast'">📊 统一客流预测</button>
      <button :class="{ on: tab === 'audit' }" @click="tab = 'audit'; loadAudit()">
        🛡️ 对账中心
        <em v-if="reconcile.driftCount" class="badge">{{ reconcile.driftCount }}</em>
      </button>
    </div>

    <!-- ============ 客流预测 ============ -->
    <div v-if="tab === 'forecast'">
      <div class="cards">
        <div class="card kpi"><span>今日预测到园</span><b>{{ stats.todayTotal.toLocaleString() }}</b>
          <small>预约 {{ stats.todayReserved }} · 散客 {{ stats.todayWalkin }}</small></div>
        <div class="card kpi"><span>明日预测到园</span><b>{{ stats.tomorrowTotal.toLocaleString() }}</b>
          <small>峰值 {{ stats.peakHour }}:00 时段</small></div>
        <div class="card kpi"><span>预测准确率（近期均值）</span><b>{{ plan.accuracy }}%</b>
          <small>日结按实际到园复盘</small></div>
        <div class="card kpi"><span>超售补退挂起</span><b :class="{ red: stats.pendingRefunds }">{{ stats.pendingRefunds }}</b>
          <small>园方欠款补偿队列</small></div>
      </div>

      <div class="card tool">
        <h3>客流来源口径</h3>
        <div class="legend">
          <span><i style="background:#5b8def"></i>散客在园（近 3 天外推）</span>
          <span><i style="background:#38bdf8"></i>散客分时预约</span>
          <span><i style="background:#a78bfa"></i>会员预约</span>
          <span><i style="background:#fbbf24"></i>领队团单名额</span>
          <span><i style="background:#fb7185"></i>热门设施折算</span>
        </div>
        <button class="btn" :disabled="busy" @click="refresh">滚动刷新预测</button>
      </div>

      <div v-for="(d, i) in plan.days" :key="d.day" class="card daycard">
        <h3>
          第 {{ d.day }} 天 · {{ DAY_LABELS[i] || '' }}
          <em class="conf">置信度 {{ d.confidence }}%</em>
          <em class="sum">合计到园 {{ d.totals.total.toLocaleString() }}（含设施折算压力 {{ d.totals.flow.toLocaleString() }}）</em>
        </h3>
        <div class="chart">
          <div v-for="h in d.hours" :key="h.hour" class="col" :class="{ past: h.past }">
            <div class="track"><div class="bar" :style="{ width: barWidth(h, d) + '%' }"
              :title="`散客${h.walkin} / 散约${h.guest_reserved} / 会员${h.member_reserved} / 团${h.group_reserved} / 设施折算${h.ride_pressure}`"></div></div>
            <span class="h">{{ h.hour }}</span>
            <span class="v">{{ h.total + h.ride_pressure }}</span>
          </div>
        </div>
        <div class="bands">
          <span v-for="b in d.bands" :key="b.key" class="bandchip">
            {{ bandName[b.key] }}：峰值 <b>{{ b.peak }}</b> / 总量 <b>{{ b.flow }}</b>
          </span>
        </div>
      </div>

      <div class="card hist" v-if="plan.history && plan.history.length">
        <h3>预测复盘（已闭园日）</h3>
        <table>
          <thead><tr><th>游戏日</th><th>开盘预测</th><th>最新预测</th><th>实际到园</th><th>准确率</th></tr></thead>
          <tbody>
            <tr v-for="h in plan.history" :key="h.day">
              <td>第 {{ h.day }} 天</td>
              <td>{{ h.open_total.toLocaleString() }}</td>
              <td>{{ h.latest_total.toLocaleString() }}</td>
              <td>{{ h.actual_total.toLocaleString() }}</td>
              <td><b :class="h.accuracy >= 80 ? 'good' : h.accuracy >= 50 ? 'warn' : 'red'">{{ h.accuracy }}%</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ============ 对账中心 ============ -->
    <div v-else class="card audit">
      <h3>一致性对账（排班 / 预约 / 会员 / 团单 / 财务）</h3>
      <p class="tip">以预约单据与团账流水为事实，重算时段库存计数、爽约补退挂起与团账汇总。写操作本身具备事务 + 幂等 + 条件更新保护，此处为最后一道防线，只修复派生计数与汇总，<b>绝不改动现金与逐条财务流水</b>。</p>
      <div class="audit-cards">
        <div class="card mini" :class="{ alert: reconcile.slotDrift }">
          <span>时段库存漂移</span><b>{{ reconcile.slotDrift }}</b><small>近三天 {{ reconcile.activeSlotDrift }} 处</small></div>
        <div class="card mini" :class="{ alert: reconcile.stalePending }">
          <span>僵尸补退挂起</span><b>{{ reconcile.stalePending }}</b><small>待补退总数 {{ reconcile.pendingRefunds }}</small></div>
        <div class="card mini" :class="{ alert: reconcile.groupDrift }">
          <span>团账汇总漂移</span><b>{{ reconcile.groupDrift }}</b><small>应收/净收款 vs 流水</small></div>
      </div>

      <div class="repairs">
        <button class="btn" :disabled="busy" @click="repair('slots')">重算时段库存计数</button>
        <button class="btn" :disabled="busy" @click="repair('pending')">作废僵尸挂起</button>
        <button class="btn" :disabled="busy" @click="repair('groups')">对齐团账汇总</button>
        <button class="btn primary" :disabled="busy" @click="repair(null)">一键全部修复</button>
        <button class="btn ghost" :disabled="busy" @click="loadAudit">重新扫描</button>
      </div>
      <div v-if="msg" class="msg" :class="msg.ok ? 'ok' : 'err'">{{ msg.text }}</div>

      <template v-if="audit?.audit">
        <div v-if="audit.audit.slots.drifts.length" class="block">
          <h4>时段库存漂移明细（{{ audit.audit.slots.drifts.length }}）</h4>
          <table>
            <thead><tr><th>日/时</th><th>类型</th><th>库存账面 booked/checked/noshow</th><th>单据事实</th><th>偏差</th></tr></thead>
            <tbody>
              <tr v-for="d in audit.audit.slots.drifts" :key="d.slot_id">
                <td>{{ d.day }}日 {{ d.hour }}:00</td><td>{{ d.scope === 'entry' ? '入园' : '设施' }}</td>
                <td>{{ d.stored.booked }}/{{ d.stored.checked }}/{{ d.stored.noshow }}</td>
                <td>{{ d.facts.booked }}/{{ d.facts.checked }}/{{ d.facts.noshow }}</td>
                <td class="warn">{{ d.delta.booked }}/{{ d.delta.checked }}/{{ d.delta.noshow }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="audit.audit.pendingRefunds.items.length" class="block">
          <h4>僵尸补退挂起（{{ audit.audit.pendingRefunds.items.length }}）</h4>
          <table>
            <thead><tr><th>挂起</th><th>预约</th><th>现状</th><th>已尝试</th><th>最近错误</th></tr></thead>
            <tbody>
              <tr v-for="p in audit.audit.pendingRefunds.items" :key="p.id">
                <td>#{{ p.id }}</td><td>#{{ p.reservation_id }}</td>
                <td class="warn">{{ p.rsv_status }}</td><td>{{ p.attempts }}</td><td class="muted">{{ p.last_error }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="audit.audit.groups.items.length" class="block">
          <h4>团账汇总漂移（{{ audit.audit.groups.items.length }}）</h4>
          <table>
            <thead><tr><th>团号</th><th>状态</th><th>账面净收款</th><th>流水净收款</th><th>应收差</th></tr></thead>
            <tbody>
              <tr v-for="g in audit.audit.groups.items" :key="g.group_id">
                <td>{{ g.code }}</td><td>{{ g.status }}</td>
                <td>{{ g.stored.net }}</td><td>{{ g.facts.net }}</td>
                <td class="warn">{{ g.delta.receivable }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="audit.audit.driftCount === 0" class="clean">✅ 全部一致：库存、挂起队列与团账均与单据事实相符，无漂移。</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; gap: 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { position: relative; background: var(--panel); border: 1px solid var(--border); color: var(--muted); padding: 8px 16px; border-radius: 10px; cursor: pointer; }
.tabs button.on { color: var(--text); border-color: rgba(255,107,107,.5); background: rgba(255,107,107,.12) }
.badge { font-style: normal; background: var(--red); color: #fff; border-radius: 10px; padding: 0 7px; margin-left: 6px; font-size: 12px; }
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.kpi span { color: var(--muted); font-size: 13px; }
.kpi b { display: block; font-size: 28px; margin: 6px 0 2px; }
.kpi small { color: var(--muted); }
.kpi b.red { color: var(--red); }
.tool { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.tool h3 { margin: 0; }
.legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.legend i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 5px; }
.daycard h3 { justify-content: flex-start; flex-wrap: wrap; }
.conf { color: #6dd5a0; font-size: 12px; font-style: normal; border: 1px solid rgba(109,213,160,.4); padding: 1px 8px; border-radius: 10px; }
.sum { color: var(--muted); font-size: 12px; font-style: normal; font-weight: 400; }
.chart { display: grid; grid-template-columns: repeat(10, 1fr); gap: 8px; align-items: end; height: 150px; padding: 6px 0; }
.col { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 3px; height: 100%; }
.track { width: 100%; height: 110px; display: flex; align-items: flex-end; }
.bar { height: 100%; width: 100%; min-height: 3px; border-radius: 5px 5px 0 0; background: linear-gradient(180deg, #5b8def, #3a6fd8); }
.col.past .bar { opacity: .4; }
.col .h { font-size: 12px; color: var(--muted); }
.col .v { font-size: 11px; }
.bands { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.bandchip { font-size: 12px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); padding: 3px 10px; border-radius: 10px; }
.bandchip b { color: var(--text); }
.hist table, .block table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
.hist th, .hist td, .block th, .block td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
.hist th, .block th { color: var(--muted); font-weight: 500; }
.good { color: #6dd5a0; } .warn { color: var(--accent2); } .red { color: var(--red); } .muted { color: var(--muted); }
.audit .tip { color: var(--muted); font-size: 13px; line-height: 1.7; margin: 6px 0 14px; }
.audit-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 14px; }
.mini span { font-size: 13px; color: var(--muted); }
.mini b { display: block; font-size: 26px; margin: 4px 0; }
.mini.alert { border-color: rgba(255,80,80,.5); }
.repairs { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 4px; }
.btn { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 9px; cursor: pointer; }
.btn.primary { background: linear-gradient(135deg,#ff6b6b,#ee5a5a); border-color: transparent; color: #fff; }
.btn.ghost { color: var(--muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.msg { margin-top: 10px; padding: 9px 12px; border-radius: 9px; font-size: 13px; }
.msg.ok { background: rgba(109,213,160,.12); color: #6dd5a0; }
.msg.err { background: rgba(255,80,80,.12); color: var(--red); }
.block { margin-top: 16px; }
.block h4 { font-size: 14px; margin: 0; }
.clean { margin-top: 14px; color: #6dd5a0; font-size: 14px; }
</style>

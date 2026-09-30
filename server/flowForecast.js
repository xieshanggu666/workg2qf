import db, { getSetting, setSetting, tx } from './db.js'

// 统一客流预测中心（客流预测 → 资源调度闭环的「事实源」）：
// 融合 4 类客流：①散客自然到园（近 3 天实际外推）②散客分时预约 ③会员预约（含免票券/快速通行券）
// ④领队团单 0 元预约；逐小时输出未来 horizon 天预测（入园 + 热门设施折算），并持久化预测快照：
//   - 每日首个营业 tick 存「开盘预测」，之后存「最新预测」；
//   - 日结回写上一营业日实际到园，计算预测准确率（闭环复盘，供后续日外推与运营调度参考）。
// 排班动态调度（scheduling.demandForDay）统一从本模块读取需求，避免预约/会员/团单/排班各算一套导致口径不一致。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

export const OPEN_HOUR = 9
export const CLOSE_HOUR = 18
export const ENTRY_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
export const RIDE_HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17]
export const HORIZON = 3                       // 始终维护今/明/后三天
const RIDE_PRESSURE_WEIGHT = 0.35              // 设施预约折算为秩序/保洁压力的权重（与历史口径一致）
const WALKIN_EXTRAPOLATE = 0.6                 // 未来日散客外推系数（沿用调度历史口径）

// 由 index.js 注入（时钟与设置读写复用 db；此处暂无需外部依赖，保留上下文便于扩展）
const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0)
}
export function initFlowContext(deps = {}) { Object.assign(ctx, deps) }

// ---------------- 预测快照持久化（幂等建表，兼容老库，独立于 db.js 主 schema） ----------------
export function ensureForecastTables() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS flow_forecast_days (
    day INTEGER PRIMARY KEY,                 -- 预测的目标游戏日
    open_total INTEGER NOT NULL DEFAULT 0,   -- 当日开盘（首个营业 tick）预测全天到园
    open_tick INTEGER NOT NULL DEFAULT 0,
    latest_total INTEGER NOT NULL DEFAULT 0, -- 最近一次预测全天到园（随库存/团单变化滚动）
    latest_tick INTEGER NOT NULL DEFAULT 0,
    actual_total INTEGER NOT NULL DEFAULT 0, -- 日结回写的实际全天到园
    accuracy INTEGER NOT NULL DEFAULT 0,     -- 开盘预测准确率（实际/预测，0-100，日结回填）
    finalized INTEGER NOT NULL DEFAULT 0     -- 是否已日结复盘（1=该日已闭园回写）
  );
  CREATE TABLE IF NOT EXISTS flow_forecast_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    guest_reserved INTEGER NOT NULL DEFAULT 0,  -- 散客（非会员）在途预约人数
    member_reserved INTEGER NOT NULL DEFAULT 0, -- 会员在途预约人数
    group_reserved INTEGER NOT NULL DEFAULT 0,  -- 领队团单在途名额
    walkin INTEGER NOT NULL DEFAULT 0,          -- 预测散客自然到园
    total INTEGER NOT NULL DEFAULT 0,           -- 预测该小时到园合计
    ride_pressure INTEGER NOT NULL DEFAULT 0,   -- 热门设施预约折算的秩序/卫生压力
    actual_total INTEGER NOT NULL DEFAULT 0,    -- 实际到园（visitors，日结回填）
    created_tick INTEGER NOT NULL DEFAULT 0,
    UNIQUE(day, hour)
  );
  CREATE INDEX IF NOT EXISTS idx_fhours_day ON flow_forecast_hours(day);
  `)
}
ensureForecastTables()

// ---------------- 班段聚合（与 scheduling.BANDS 同口径，便于调度直接消费） ----------------
export const FORECAST_BANDS = [
  { key: 'morning', label: '早班', hours: [9, 10, 11] },
  { key: 'mid', label: '中班', hours: [12, 13] },
  { key: 'evening', label: '晚班', hours: [14, 15, 16, 17] },
  { key: 'night', label: '夜班', hours: [17] }
]

// 营业时段散客系数（与主引擎 tick 中 retail 一致：早晚人少）
function retailOf(hour) {
  return hour <= 6 ? 0.5 : hour >= 16 ? 0.6 : 1
}

// 近 3 天（不含当天）逐小时实际散客 = visitors.count - 当日预约核销入园；返回 Map<hour, avg>
export function avgWalkinByHour() {
  const today = ctx.day()
  const rows = db.prepare(`
    SELECT hour,
           AVG(count) avg_total,
           AVG((SELECT COALESCE(SUM(r.qty),0) FROM reservations r
                WHERE r.status='checked' AND r.scope='entry' AND r.slot_day=v.day AND r.slot_hour=v.hour)) avg_rsv
    FROM visitors v
    WHERE day BETWEEN ? AND ?
    GROUP BY hour`).all(Math.max(1, today - 3), today - 1)
  const map = new Map()
  for (const r of rows) map.set(r.hour, Math.max(0, num(r.avg_total) - num(r.avg_rsv)))
  return map
}

function activeEventFactor(day) {
  // 已确认会影响客流的进行中事件（按目标日近似：进行中事件对今日/次日均生效，保守取值）
  const rows = db.prepare("SELECT type, impact FROM events WHERE status='active'").all()
  let mul = 1
  for (const e of rows) {
    if (e.type === 'weather') mul *= 0.9
    else if (e.type === 'crowd') mul *= 1.08
    else if (e.type === 'celebrity') mul *= 1.1
    else if (e.type === 'protest') mul *= 0.92
  }
  return mul
}

// 在途预约按来源拆分（散客/会员/团单），一次查全天各小时
function reservedByHour(day, scope = 'entry') {
  const rows = db.prepare(`
    SELECT slot_hour AS hour,
           COALESCE(SUM(CASE WHEN source='group' OR group_item_id IS NOT NULL THEN qty END),0) AS grp,
           COALESCE(SUM(CASE WHEN (source IS NULL OR source<>'group') AND group_item_id IS NULL AND member_id IS NOT NULL THEN qty END),0) AS mem,
           COALESCE(SUM(CASE WHEN (source IS NULL OR source<>'group') AND group_item_id IS NULL AND member_id IS NULL THEN qty END),0) AS gst
    FROM reservations
    WHERE status='booked' AND scope=? AND slot_day=?
    GROUP BY slot_hour`).all(scope, day)
  const map = new Map()
  for (const r of rows) map.set(r.hour, { guest: r.gst, member: r.mem, group: r.grp })
  return map
}

// 设施预约折算压力：逐小时全部设施在途预约人数 × 权重
function ridePressureByHour(day) {
  const rows = db.prepare(`
    SELECT slot_hour AS hour, COALESCE(SUM(qty),0) n
    FROM reservations
    WHERE status='booked' AND scope='ride' AND slot_day=?
    GROUP BY slot_hour`).all(day)
  const map = new Map()
  for (const r of rows) map.set(r.hour, Math.round(r.n * RIDE_PRESSURE_WEIGHT))
  return map
}

// 某日逐小时预测（只读计算；isFuture 决定散客是走实际滚动还是外推）
export function hourlyForecast(day, walkMap = avgWalkinByHour()) {
  day = Math.round(num(day))
  const today = ctx.day()
  const curHour = ctx.hour()
  const entryMap = reservedByHour(day, 'entry')
  const rideMap = ridePressureByHour(day)
  const base = num(getSetting('guestBase'), 600)
  const ticket = num(getSetting('ticket'), 120)
  const rep = num(getSetting('reputation'), 70)
  const wom = num(getSetting('wordOfMouth'), 0)
  const priceFactor = Math.max(0.2, 2.0 - ticket / 100)
  const repFactor = 0.4 + rep / 100
  const womFactor = Math.max(0.7, 1 + wom * 0.012)
  const eventFactor = activeEventFactor(day)
  const out = []
  for (let hour = OPEN_HOUR; hour <= CLOSE_HOUR; hour++) {
    const rsv = entryMap.get(hour) || { guest: 0, member: 0, group: 0 }
    const ridePressure = rideMap.get(hour) || 0
    const reserved = rsv.guest + rsv.member + rsv.group
    let walkin = 0
    const isPast = day < today || (day === today && hour < curHour)
    if (!isPast) {
      if (day > today) {
        // 未来日：近 3 天散客均值外推；无历史时按基准客流 × 时段系数兜底（沿用调度历史口径）
        const hist = walkMap.get(hour)
        const fallback = base * (hour <= 10 ? 0.5 : hour >= 16 ? 0.6 : 1) * WALKIN_EXTRAPOLATE
        walkin = Math.round((hist ? hist * WALKIN_EXTRAPOLATE : fallback) * womFactor * eventFactor)
      } else if (hour > curHour) {
        // 今日未开始时段：散客用当前模型即时预测（票价/声誉/口碑/事件），不再用历史均值
        const raw = base * retailOf(hour) * priceFactor * repFactor * womFactor * eventFactor
        walkin = Math.round(raw)
      }
      // 当日已开始/正当时段不预测散客（由实际到园滚动），保持 reserved 口径即可
    }
    const total = reserved + walkin
    out.push({
      hour, day,
      guest_reserved: rsv.guest,
      member_reserved: rsv.member,
      group_reserved: rsv.group,
      reserved,
      walkin,
      ride_pressure: ridePressure,
      total,
      // 调度消费的「综合压力」= 预约入园 + 设施排队折算（与旧 hourlyFlow.flow 口径一致）
      flow: total + ridePressure,
      past: isPast ? 1 : 0
    })
  }
  return out
}

// 全天预测汇总：班段峰值/总量 + 来源构成
export function forecastForDay(day) {
  day = Math.round(num(day))
  const walkMap = avgWalkinByHour()
  const hours = hourlyForecast(day, walkMap)
  const sum = k => hours.reduce((s, h) => s + h[k], 0)
  const totals = {
    guestReserved: sum('guest_reserved'),
    memberReserved: sum('member_reserved'),
    groupReserved: sum('group_reserved'),
    reserved: sum('reserved'),
    walkin: sum('walkin'),
    total: sum('total'),
    ridePressure: sum('ride_pressure'),
    flow: sum('flow')
  }
  const hasHistory = db.prepare('SELECT COUNT(DISTINCT day) n FROM visitors WHERE day BETWEEN ? AND ?')
    .get(Math.max(1, day - 3), day - 1).n >= 2
  // 置信度：越近越准；有 ≥2 天历史散客可外推时上浮
  const dist = Math.max(0, day - ctx.day())
  const confidence = Math.max(20, Math.min(95, ([80, 60, 45][dist] ?? 35) + (hasHistory ? 8 : 0)))
  const bands = FORECAST_BANDS.map(b => {
    const hs = hours.filter(h => b.hours.includes(h.hour))
    return {
      key: b.key, label: b.label, hours: b.hours,
      reserved: hs.reduce((s, h) => s + h.reserved, 0),
      walkin: hs.reduce((s, h) => s + h.walkin, 0),
      flow: hs.reduce((s, h) => s + h.flow, 0),
      peak: hs.reduce((m, h) => Math.max(m, h.flow), 0)
    }
  })
  return { day, isToday: day === ctx.day(), hours, bands, totals, confidence }
}

// ---------------- 快照写入 / 日结回写 ----------------
const upsertDay = db.prepare(`INSERT INTO flow_forecast_days(day,open_total,open_tick,latest_total,latest_tick)
                             VALUES(?,?,?,?,?)
                             ON CONFLICT(day) DO UPDATE SET
                               latest_total=excluded.latest_total, latest_tick=excluded.latest_tick`)
const upsertHour = db.prepare(`INSERT INTO flow_forecast_hours
                               (day,hour,guest_reserved,member_reserved,group_reserved,walkin,total,ride_pressure,created_tick)
                               VALUES(?,?,?,?,?,?,?,?,?)
                               ON CONFLICT(day,hour) DO UPDATE SET
                                 guest_reserved=excluded.guest_reserved,
                                 member_reserved=excluded.member_reserved,
                                 group_reserved=excluded.group_reserved,
                                 walkin=excluded.walkin,
                                 total=excluded.total,
                                 ride_pressure=excluded.ride_pressure,
                                 created_tick=excluded.created_tick`)

// 刷新未来 HORIZON 天的预测快照；每个营业小时（或预约/团单库存变化后）调用。
// 每日第一个营业 tick 的预测会作为「开盘预测」固化（open_total 只写一次），之后只滚动 latest。
export function refreshForecasts({ horizon = HORIZON } = {}) {
  ensureForecastTables()
  const today = ctx.day()
  const tickNow = ctx.tick()
  const isOpenTick = ctx.hour() === OPEN_HOUR
  const saved = []
  for (let d = 0; d < horizon; d++) {
    const day = today + d
    const f = forecastForDay(day)
    const existing = db.prepare('SELECT open_total, open_tick FROM flow_forecast_days WHERE day=?').get(day)
    // 开盘固化：当天首个营业 tick 且尚无开盘记录；未来日沿用其首次生成时的预测
    const isOpen = (d === 0 && isOpenTick) || !existing
    db.prepare(`INSERT INTO flow_forecast_days(day,open_total,open_tick,latest_total,latest_tick)
                VALUES(?,?,?,?,?)
                ON CONFLICT(day) DO UPDATE SET
                  open_total=CASE WHEN flow_forecast_days.open_tick=0 THEN excluded.open_total ELSE flow_forecast_days.open_total END,
                  open_tick=CASE WHEN flow_forecast_days.open_tick=0 THEN excluded.open_tick ELSE flow_forecast_days.open_tick END,
                  latest_total=excluded.latest_total, latest_tick=excluded.latest_tick`)
      .run(day, f.totals.total, isOpen ? tickNow : 0, f.totals.total, tickNow)
    for (const h of f.hours) {
      upsertHour.run(day, h.hour, h.guest_reserved, h.member_reserved, h.group_reserved, h.walkin, h.total, h.ride_pressure, tickNow)
    }
    saved.push({ day, total: f.totals.total, open: isOpen })
  }
  return { ok: true, days: saved }
}

// 日结复盘：回写上一营业日的实际到园与预测准确率（actual/开盘预测，封顶 100）。
// 在新一天 9:00 首个 tick（day 已 +1）调用，finalizeDay = ctx.day()-1。
export function finalizeDayForecast(day) {
  day = Math.round(num(day))
  const actualRow = db.prepare(`
    SELECT COALESCE(SUM(count),0) total
    FROM visitors WHERE day=?`).get(day)
  const actual = num(actualRow?.total)
  const actualByHour = db.prepare('SELECT hour, count FROM visitors WHERE day=?').all(day)
  return tx(() => {
    for (const r of actualByHour) {
      db.prepare('UPDATE flow_forecast_hours SET actual_total=? WHERE day=? AND hour=?')
        .run(r.count, day, r.hour)
    }
    const snap = db.prepare('SELECT * FROM flow_forecast_days WHERE day=?').get(day)
    const base = snap?.open_total > 0 ? snap.open_total : snap?.latest_total || 0
    const accuracy = base > 0 && actual > 0
      ? Math.round(Math.max(0, Math.min(100, 100 - Math.abs(actual - base) / base * 100)))
      : 0
    db.prepare(`INSERT INTO flow_forecast_days(day,open_total,open_tick,latest_total,latest_tick,actual_total,accuracy,finalized)
                VALUES(?,?,?,?,?,?,?,1)
                ON CONFLICT(day) DO UPDATE SET actual_total=excluded.actual_total,
                  accuracy=excluded.accuracy, finalized=1`)
      .run(day, snap?.open_total || 0, snap?.open_tick || 0, snap?.latest_total || actual, snap?.latest_tick || 0, actual, accuracy)
    return { ok: true, day, actual, predicted: base, accuracy }
  })
}

// ---------------- 查询 ----------------
// 未来 horizon 天预测（滚动最新）+ 已完成日复盘（准确率），供「客流预测」页面展示
export function forecastPlan({ horizon = HORIZON, includeHistory = 1 } = {}) {
  const today = ctx.day()
  const days = []
  for (let d = today; d <= today + horizon - 1; d++) days.push(forecastForDay(d))
  const history = includeHistory
    ? db.prepare('SELECT * FROM flow_forecast_days WHERE day<? ORDER BY day DESC LIMIT ?').all(today, num(includeHistory) === true ? 5 : Number(includeHistory))
    : []
  const avgAccuracy = history.filter(h => h.finalized && h.accuracy > 0)
  const accuracy = avgAccuracy.length
    ? Math.round(avgAccuracy.reduce((s, h) => s + h.accuracy, 0) / avgAccuracy.length)
    : 0
  return {
    today,
    horizon,
    days,
    history,
    accuracy,
    params: {
      guestBase: num(getSetting('guestBase'), 600),
      ticket: num(getSetting('ticket'), 120),
      wordOfMouth: num(getSetting('wordOfMouth'), 0),
      walkinExtrapolate: WALKIN_EXTRAPOLATE,
      ridePressureWeight: RIDE_PRESSURE_WEIGHT
    }
  }
}

// 供调度模块消费：某日某班段的综合客流压力（峰值用于秩序岗、总量用于卫生岗）
export function bandFlow(day, bandKey) {
  const f = forecastForDay(day)
  const b = f.bands.find(x => x.key === bandKey)
  return b ? { peak: b.peak, flow: b.flow } : { peak: 0, flow: 0 }
}

// 供引擎/API 调用的轻量统计（顶部异常光环等）
export function forecastStats() {
  const today = ctx.day()
  const f = forecastForDay(today)
  const pendingRefunds = db.prepare("SELECT COUNT(*) n FROM reservation_pending_actions WHERE status='pending'").get().n
  return {
    todayTotal: f.totals.total,
    todayReserved: f.totals.reserved,
    todayWalkin: f.totals.walkin,
    tomorrowTotal: forecastForDay(today + 1).totals.total,
    peakHour: f.hours.reduce((m, h) => h.flow > (m.flow || 0) ? h : m, { hour: 0, flow: 0 }).hour,
    pendingRefunds
  }
}

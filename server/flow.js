import db, { getSetting, setSetting, tx, afterCommit } from './db.js'

// 统一客流预测与资源调度闭环模块：
// ① 统一客流预测：散客入园预约 + 团队名额（含待确认置信折算）+ 会员预约 + 热门设施预约折算 + 散客外推（自适应学习）
//    → 每营业小时快照落库（flow_forecast_snapshots），作为动态排班需求画像与跨日夜班衔接的唯一事实源；
// ② 检修/投诉优先级：严重度 × SLA 剩余时限 × 状态（排队/检修中/紧急）统一打分，驱动补位与紧急调令的先后；
// ③ 闭环一致性巡检：时段库存计数器、退款-现金-财务流水、团账收退、考勤结算与跨日排班冲突的对账，
//    安全项（计数器漂移）自动自愈，资金项只告警不擅改，杜绝排班、预约与财务状态不一致。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const OPEN_HOUR = 9
const CLOSE_HOUR = 18
const HOURS_PER_DAY = 10
const RIDE_FLOW_WEIGHT = 0.35        // 设施预约折算秩序/卫生客流的权重（与旧版画像口径保持一致）
const PENDING_GROUP_CONFIDENCE = 0.7 // 待确认团单按 70% 置信计入预测（确认/拒绝后自动校正）
const FACTOR_KEY = 'flowWalkinFactor'
const FACTOR_ALPHA = 0.4             // 自适应学习：新观测权重
const FACTOR_MIN = 0.6
const FACTOR_MAX = 1.6
const FORECAST_DAYS = 3

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), OPEN_HOUR),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  // 由 index.js 注入：库存/团单变化后触发动态调度重算（仅动态模式 + 自动补位开启时生效）
  dispatchAfter: null
}
export function initFlowContext(deps = {}) { Object.assign(ctx, deps) }

// 班段定义（排班模块复用，保证预测小时 → 班段的映射全局唯一）
export const BANDS = [
  { key: 'morning', shift_code: 'morning', label: '早班', hours: [9, 10, 11] },
  { key: 'mid', shift_code: 'mid', label: '中班', hours: [12, 13] },
  { key: 'evening', shift_code: 'evening', label: '晚班', hours: [14, 15, 16, 17] },
  { key: 'night', shift_code: 'night', label: '夜班', hours: [17] }
]
export const GUARD_ROLE_SET = ['保安', '安保']
export const RIDE_HOURS_ALL = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, i) => OPEN_HOUR + i)

const walkinFactor = () => Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, num(getSetting(FACTOR_KEY), 1)))

// ---------------- 历史散客与自适应学习 ----------------
// 近 3 天每营业小时：实际总入园 − 预约核销入园（含团队）= 真实散客，做未来日外推基线
export function avgWalkinByHour(untilDay = ctx.day() - 1) {
  const rows = db.prepare(`
    SELECT hour,
           AVG(count) avg_total,
           AVG((SELECT COALESCE(SUM(r.qty),0) FROM reservations r
                WHERE r.status='checked' AND r.scope='entry' AND r.slot_day=v.day AND r.slot_hour=v.hour)) avg_rsv
    FROM visitors v
    WHERE day BETWEEN ? AND ?
    GROUP BY hour`).all(Math.max(1, untilDay - 2), untilDay)
  const map = new Map()
  for (const r of rows) map.set(r.hour, Math.max(0, num(r.avg_total) - num(r.avg_rsv)))
  return map
}

function fallbackWalkin(hour) {
  // 新园无历史：基准客流 × 时段系数兜底（与旧版画像一致）
  return Math.round(num(getSetting('guestBase'), 600) * (hour <= 10 ? 0.5 : hour >= 16 ? 0.6 : 1))
}

// ---------------- 统一客流预测（纯计算，不落库） ----------------
// 团队名额：已确认全额计入，待确认按置信度折算；返回 { entry, ride } 按小时 Map
function groupReservedByHour(day) {
  const entry = new Map(), ride = new Map()
  const rows = db.prepare(`
    SELECT gi.kind, gi.slot_hour, gi.ride_id,
           SUM(CASE WHEN g.status='pending' THEN ROUND(gi.qty - gi.checked_qty - gi.refunded_qty, 0) * ?
                    ELSE gi.qty - gi.checked_qty - gi.refunded_qty END) qty
    FROM group_items gi JOIN group_orders g ON g.id=gi.group_id
    WHERE gi.slot_day=? AND g.status IN ('pending','confirmed','settled')
      AND gi.status IN ('pending','active','rerouted','interrupted')
    GROUP BY gi.kind, gi.slot_hour, gi.ride_id`)
    .all(PENDING_GROUP_CONFIDENCE, day)
  for (const r of rows) {
    const q = Math.round(num(r.qty))
    if (q <= 0) continue
    if (r.kind === 'entry') entry.set(r.slot_hour, (entry.get(r.slot_hour) || 0) + q)
    else ride.set(r.slot_hour, (ride.get(r.slot_hour) || 0) + q)
  }
  return { entry, ride }
}

// 某日每营业小时的统一客流预测（与动态排班需求画像同一口径）
export function hourlyForecast(day, walkMap = avgWalkinByHour()) {
  const group = groupReservedByHour(day)
  const out = []
  const factor = walkinFactor()
  for (let hour = OPEN_HOUR; hour <= CLOSE_HOUR; hour++) {
    // 入园预约在途（散客 + 会员；团队 0 元预约也占用同一库存，已含在 booked_count 内）
    const entryBooked = num(db.prepare("SELECT COALESCE(SUM(booked_count),0) n FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?")
      .get(day, hour).n)
    const rideBookedRaw = num(db.prepare("SELECT COALESCE(SUM(booked_count),0) n FROM reservation_slots WHERE scope='ride' AND day=? AND hour=?")
      .get(day, hour).n)
    const memberEntry = num(db.prepare(`SELECT COALESCE(SUM(r.qty),0) n FROM reservations r
                                        WHERE r.status='booked' AND r.scope='entry' AND r.slot_day=? AND r.slot_hour=? AND r.member_id IS NOT NULL`)
      .get(day, hour).n)
    // 团队拆分明细（库存里已含团队名额，这里只做构成拆分，不重复加入总量）
    const groupEntry = group.entry.get(hour) || 0
    const groupRideRaw = group.ride.get(hour) || 0
    const guestEntry = Math.max(0, entryBooked - groupEntry)
    const memberShare = entryBooked > 0 ? Math.round(memberEntry / entryBooked * 100) / 100 : 0
    const rideWeighted = Math.round(rideBookedRaw * RIDE_FLOW_WEIGHT)
    let walkin = 0
    if (day > ctx.day()) {
      // 未来日按近 3 天散客均值 × 自适应系数外推（新园无历史时走基准客流时段系数兜底）；
      // 今日散客由引擎按实时声誉/票价产生，不外推，避免与实时客流重复计算
      const hist = walkMap.get(hour)
      walkin = Math.round((hist || fallbackWalkin(hour)) * factor)
    }
    const flow = entryBooked + rideWeighted + walkin
    out.push({
      hour, entry: entryBooked, guestEntry, groupEntry, memberEntry,
      rideRaw: rideBookedRaw, groupRideRaw, ride: rideWeighted,
      walkin, flow, memberShare
    })
  }
  return out
}

// 全日统一预测汇总（闭环看板/排班入口共用）
export function forecastForDay(day) {
  day = Math.round(num(day))
  const hours = hourlyForecast(day)
  const sum = k => hours.reduce((s, h) => s + (h[k] || 0), 0)
  return {
    day,
    isToday: day === ctx.day(),
    hours,
    bands: BANDS.map(b => {
      const hs = hours.filter(h => b.hours.includes(h.hour))
      return {
        key: b.key, label: b.label, hours: b.hours,
        flow: hs.reduce((s, h) => s + h.flow, 0),
        peak: hs.reduce((m, h) => Math.max(m, h.flow), 0),
        entry: hs.reduce((s, h) => s + h.entry, 0),
        walkin: hs.reduce((s, h) => s + h.walkin, 0)
      }
    }),
    predictedFlow: sum('flow'),
    reserveEntry: sum('entry'),
    guestEntry: sum('guestEntry'),
    groupEntry: sum('groupEntry'),
    memberEntry: sum('memberEntry'),
    reserveRide: sum('ride'),
    reserveRideRaw: sum('rideRaw'),
    walkinForecast: sum('walkin'),
    memberShare: sum('entry') > 0 ? Math.round(sum('memberEntry') / sum('entry') * 100) / 100 : 0,
    factor: walkinFactor()
  }
}

// ---------------- 预测快照（每小时刷新，日结回填实际值学习） ----------------
function upsertSnapshot(day, hour, patch) {
  const cur = db.prepare('SELECT id FROM flow_forecast_snapshots WHERE day=? AND hour=?').get(day, hour)
  const sets = Object.keys(patch)
  const vals = sets.map(k => patch[k])
  if (cur) {
    db.prepare(`UPDATE flow_forecast_snapshots SET ${sets.map(k => `${k}=?`).join(',')}, update_tick=?, update_day=? WHERE id=?`)
      .run(...vals, ctx.tick(), ctx.day(), cur.id)
  } else {
    db.prepare(`INSERT INTO flow_forecast_snapshots(day,hour,${sets.join(',')},update_tick,update_day) VALUES(?,?${sets.map(() => ',?').join('')},?,?)`)
      .run(day, hour, ...vals, ctx.tick(), ctx.day())
  }
}

// 引擎每小时调用：刷新今/明/后三天预测快照（库存变化后的统一预测落库）。
// 今日散客由引擎实时产生（walkin=0），但不得覆盖该日「仍为未来日」时生成的散客外推基线——
// 日结学习要对比的正是预测基线与真实散客；故今日行的 walkin 字段保留历史值，仅刷新预约/团队/总量构成。
export function refreshForecastSnapshots() {
  const walkMap = avgWalkinByHour()
  tx(() => {
    for (let d = 0; d < FORECAST_DAYS; d++) {
      const day = ctx.day() + d
      const f = forecastForDay(day)
      const preserve = d === 0
        ? db.prepare('SELECT walkin_forecast FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(day)
        : null
      upsertSnapshot(day, 0, {
        predicted_flow: f.predictedFlow,
        reserve_entry: f.reserveEntry,
        group_entry: f.groupEntry,
        reserve_ride: f.reserveRide,
        walkin_forecast: preserve ? Math.max(preserve.walkin_forecast, f.walkinForecast) : f.walkinForecast,
        member_share: f.memberShare,
        adjust_factor: f.factor
      })
      for (const h of f.hours) {
        const prev = d === 0
          ? db.prepare('SELECT walkin_forecast FROM flow_forecast_snapshots WHERE day=? AND hour=?').get(day, h.hour)
          : null
        upsertSnapshot(day, h.hour, {
          predicted_flow: h.flow,
          reserve_entry: h.entry,
          group_entry: h.groupEntry,
          reserve_ride: h.ride,
          walkin_forecast: prev ? Math.max(prev.walkin_forecast, h.walkin) : h.walkin,
          member_share: h.memberShare,
          adjust_factor: f.factor
        })
      }
    }
    return { ok: true }
  })
}

// 日结自适应学习：对比昨日预测散客与真实散客，EMA 更新外推系数；回填快照精度。
// 幂等：目标日快照已 settled 直接跳过（闭园 tick 与当日后续 tick 都可能调用，绝不重复学习）。
// learningDay 为刚结束的游戏日（调用方在跨日推进后传入 ctx.day()-1）。
export function settleForecastLearning(learningDay) {
  return tx(() => {
    const snap0 = db.prepare('SELECT settled FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(learningDay)
    if (!snap0) return { ok: true, skipped: true, reason: 'no_snapshot' }
    if (snap0.settled) return { ok: true, skipped: true, reason: 'already_settled' }
    const actualTotal = num(db.prepare('SELECT COALESCE(SUM(count),0) n FROM visitors WHERE day=?').get(learningDay).n)
    const actualEntryChecked = num(db.prepare(`SELECT COALESCE(SUM(r.qty),0) n FROM reservations r
      WHERE r.status='checked' AND r.scope='entry' AND r.slot_day=?`).get(learningDay).n)
    const actualWalkin = Math.max(0, actualTotal - actualEntryChecked)
    const snap = db.prepare('SELECT * FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(learningDay)
    // 首日/无历史日对散客的预测基线为 0（当日散客由引擎实时产生），不具学习意义，仅回填实际值
    if (snap.walkin_forecast < 50) {
      db.prepare(`UPDATE flow_forecast_snapshots
        SET actual_flow=?, accuracy=0, settled=1, settle_tick=?
        WHERE day=? AND settled=0`).run(actualTotal, ctx.tick(), learningDay)
      return { ok: true, skipped: true, reason: 'no_walkin_baseline' }
    }
    const predictedWalkin = Math.max(1, snap.walkin_forecast)
    const observed = Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, actualWalkin / predictedWalkin))
    const oldFactor = num(snap.adjust_factor, 1)
    const factor = Math.round((oldFactor * (1 - FACTOR_ALPHA) + observed * FACTOR_ALPHA) * 1000) / 1000
    setSetting(FACTOR_KEY, Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, factor)))
    const accuracy = snap.predicted_flow > 0
      ? Math.round(Math.max(0, 1 - Math.abs(snap.predicted_flow - actualTotal) / snap.predicted_flow) * 1000) / 1000
      : 0
    db.prepare(`UPDATE flow_forecast_snapshots
       SET actual_flow=?, accuracy=?, adjust_factor=?, settled=1, settle_tick=?
       WHERE day=? AND settled=0`)
      .run(actualTotal, accuracy, factor, ctx.tick(), learningDay)
    return { ok: true, actualWalkin, predictedWalkin, observed, factor, accuracy }
  })
}

export function forecastStats() {
  const today = ctx.day()
  const recent = db.prepare('SELECT day,predicted_flow,actual_flow,accuracy,settled FROM flow_forecast_snapshots WHERE hour=0 AND day>=? ORDER BY day LIMIT 5').all(today - 2)
  const settled = recent.filter(r => r.settled)
  const avgAccuracy = settled.length ? Math.round(settled.reduce((s, r) => s + r.accuracy, 0) / settled.length * 100) : null
  return {
    factor: walkinFactor(),
    days: recent,
    avgAccuracy,
    pendingGroupsConfidence: PENDING_GROUP_CONFIDENCE
  }
}

// ---------------- 检修 / 投诉统一优先级评分 ----------------
// 分值越高越优先：严重度（30/55/85）+ SLA 紧迫度（0~30，已超时封顶）+ 状态加权（检修中/排队）
// 用于需求画像挂载顺序、缺口补位顺序与紧急加班调令选人的统一依据。
export function complaintPriority(c) {
  const sevBase = { 1: 30, 2: 55, 3: 85 }[c.severity] || 30
  const sla = num(c.deadline_tick) - ctx.tick()
  const slaScore = c.status === 'open'
    ? Math.max(0, Math.min(30, 30 - Math.max(0, sla) * 2)) + (sla < 0 ? 15 : 0)
    : c.status === 'processing' ? 12 : 6
  const escalated = c.escalated ? 8 : 0
  return Math.round(sevBase + slaScore + escalated)
}

export function maintenancePriority(o) {
  // 检修中（设施持续停运、预约持续退款）高于排队；进度低意味着停运更久，略微加权
  const statusBase = o.status === 'processing' ? 70 : 50
  const progressPenalty = Math.round((100 - num(o.progress)) / 10)
  return statusBase + progressPenalty
}

// ---------------- 闭环一致性巡检（对账 + 安全自愈） ----------------
// 1) 时段库存计数器：以预约单 + 团行程退款人数为事实源重算 booked/checked/noshow/refund，漂移即自愈。
// booked_count 口径（严格复刻 reservations.js / groups.js 全部写入路径）：
//   散客：建单/改签占用 +qty，取消/园退 −qty；核销/爽约不回补名额。故 booked = booked/checked/noshow 单 qty 之和
//         （退款态散客已在取消路径释放，不计入）；
//   团队：建团预约 0 元占 +qty，部分退团/停运释放 −refunded_qty，且预约单 qty 同步收缩为剩余人数。
//         故团 booked 直接取预约当前 qty（qty 已等于扣减退款后的占名额人数），无需再加 refunded_qty。
// noshow_count：散客爽约 +qty；团爽约 +remain（= 收缩后 qty）。
// refund_count：散客取消/园退 +qty；团部分退团 +refunded_qty（取自 group_items）。
function expectedSlotCounts() {
  return db.prepare(`
    SELECT slot_id,
      SUM(CASE WHEN status IN ('booked','checked','noshow') THEN qty ELSE 0 END) booked,
      SUM(CASE WHEN status='checked' THEN qty ELSE 0 END) checked,
      SUM(CASE WHEN status='noshow' THEN qty ELSE 0 END) noshow,
      SUM(CASE WHEN group_item_id IS NOT NULL
               THEN COALESCE((SELECT gi.refunded_qty FROM group_items gi WHERE gi.id=reservations.group_item_id), 0)
               WHEN status IN ('refunded','refunded_half') THEN qty ELSE 0 END) refunded
    FROM reservations WHERE slot_id IS NOT NULL
    GROUP BY slot_id`).all()
}

function recordFinding({ kind, level = 'warn', refType = '', refId = null, day = 0, title, detail = '', expected = '', actual = '', heal = false }) {
  const id = Number(db.prepare(`INSERT INTO reconcile_findings
      (code,kind,level,ref_type,ref_id,day,title,detail,expected,actual,status,tick,created_day,heal_tick)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'open', ?, ?, ?)`)
    .run('', kind, level, refType, refId, day, title, detail,
      JSON.stringify(expected), JSON.stringify(actual), ctx.tick(), ctx.day(), heal ? ctx.tick() : 0).lastInsertRowid)
  const code = 'RC' + String(id).padStart(4, '0')
  db.prepare('UPDATE reconcile_findings SET code=? WHERE id=?').run(code, id)
  if (heal) db.prepare("UPDATE reconcile_findings SET status='healed' WHERE id=?").run(id)
  return { id, code, healed: heal }
}

// 巡检主入口：返回本轮发现与自愈明细。autoHeal=true 时计数器漂移直接修复（仅改计数列，不动资金）。
export function runReconcile({ autoHeal = true, logEvent = false } = {}) {
  const findings = []
  const healed = []
  tx(() => {
    // ---- 1) 时段计数器对账（安全自愈） ----
    for (const row of expectedSlotCounts()) {
      const slot = db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(row.slot_id)
      if (!slot) continue
      const exp = {
        booked: num(row.booked), checked: num(row.checked),
        noshow: num(row.noshow), refunded: num(row.refunded)
      }
      const act = {
        booked: slot.booked_count, checked: slot.checked_count,
        noshow: slot.noshow_count, refunded: slot.refund_count
      }
      if (exp.booked !== act.booked || exp.checked !== act.checked || exp.noshow !== act.noshow || exp.refunded !== act.refunded) {
        if (autoHeal) {
          db.prepare(`UPDATE reservation_slots SET booked_count=?, checked_count=?, noshow_count=?, refund_count=? WHERE id=?`)
            .run(exp.booked, exp.checked, exp.noshow, exp.refunded, slot.id)
        }
        const f = recordFinding({
          kind: 'slot_counter', level: 'block', refType: 'slot', refId: slot.id, day: slot.day,
          title: `时段 ${slot.day}日 ${slot.hour}:00 ${slot.scope === 'entry' ? '入园' : '设施'}库存计数器漂移`,
          detail: `已约/核销/爽约/退款计数与预约单重算结果不一致${autoHeal ? '，已按预约单事实源自动校正' : '，未自动修复'}`,
          expected: exp, actual: act, heal: autoHeal
        })
        findings.push(f); if (autoHeal) healed.push(f)
      }
    }

    // ---- 2) 退款资金对账：每笔现金退款必须有等额财务流水，且现金口径无重退 ----
    const refundRows = db.prepare(`
      SELECT r.id, r.code, r.slot_day day, r.refund_amount back, r.refund_fee fee
      FROM reservations r WHERE r.status IN ('refunded','refunded_half') AND r.refund_amount>0`)
      .all()
    for (const r of refundRows) {
      const fin = num(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM finance WHERE label IN ('门票','游乐') AND amount<0 AND detail LIKE ?")
        .get(`%${r.code}%`).s)
      // 散客退款流水 detail 带预约号；团队 0 元预约无现金退款（走团账），不在此列
      if (fin === 0 && r.back > 0) {
        const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind='finance_refund' AND ref_id=? AND status='open'").get(r.id)
        if (!exists) findings.push(recordFinding({
          kind: 'finance_refund', level: 'block', refType: 'reservation', refId: r.id, day: r.day,
          title: `预约 ${r.code} 退款资金缺少对应财务流水`,
          detail: `预约已退款 ¥${r.back}，但未找到等额退款财务流水，存在财务与预约状态不一致风险，请人工核对`,
          expected: { finance: -r.back }, actual: { finance: 0 }
        }))
      }
    }

    // ---- 3) 团账对账：收款/退款/没收流水合计须与团单字段一致 ----
    const groups = db.prepare("SELECT * FROM group_orders WHERE status<>'pending'").all()
    for (const g of groups) {
      const pay = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN kind IN ('deposit','balance') THEN amount END),0) in_amt,
          COALESCE(SUM(CASE WHEN kind LIKE 'refund%' THEN -amount END),0) out_amt,
          COALESCE(SUM(CASE WHEN kind IN ('fee','noshow') THEN amount END),0) fee_amt
        FROM group_payments WHERE group_id=?`).get(g.id)
      if (num(pay.in_amt) !== g.deposit_amount + g.paid_balance ||
          num(pay.out_amt) !== g.refunded_amount ||
          num(pay.fee_amt) !== g.fee_amount) {
        const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind='group_ledger' AND ref_id=? AND status='open'").get(g.id)
        if (!exists) findings.push(recordFinding({
          kind: 'group_ledger', level: 'block', refType: 'group', refId: g.id, day: g.visit_day,
          title: `团单 ${g.code} 账务流水与团单金额不一致`,
          detail: '订金/尾款/退款/手续费流水合计与团单字段不符，请人工核对（系统不擅自改写资金）',
          expected: { in: g.deposit_amount + g.paid_balance, out: g.refunded_amount, fee: g.fee_amount },
          actual: { in: num(pay.in_amt), out: num(pay.out_amt), fee: num(pay.fee_amt) }
        }))
      }
    }

    // ---- 4) 考勤结算对账：已下班/离岗/旷工必须有结算日，计薪班次必须有工资流水 ----
    const atts = db.prepare(`SELECT a.*, s.name staff_name FROM staff_attendance a
                             JOIN staff s ON s.id=a.staff_id
                             WHERE a.status IN ('checked_out','leave','absent') AND a.settle_day=0 LIMIT 50`).all()
    for (const a of atts) {
      const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind='attendance' AND ref_id=? AND status='open'").get(a.id)
      if (!exists) findings.push(recordFinding({
        kind: 'attendance', level: 'warn', refType: 'attendance', refId: a.id, day: a.day,
        title: `考勤 ${a.code}（${a.staff_name}）已结束但缺少结算日`,
        detail: '考勤已下班/离岗/旷工却未标记结算日，工资可能漏结，排班与财务口径存在偏差'
      }))
    }

    // ---- 5) 跨日排班硬冲突：同一员工相邻两日均有有效排班，且前一日为跨日夜班、次日班次在其下班(9:00)前开始 ----
    const nights = db.prepare(`
      SELECT sc.id, sc.staff_id, sc.day, s.name staff_name, sh2.id next_shift, sh2.start_hour next_start, sh2.cross_day next_cross, sc2.day next_day
      FROM staff_schedules sc
      JOIN staff s ON s.id=sc.staff_id
      JOIN shift_templates sh ON sh.id=sc.shift_id AND sh.cross_day=1
      JOIN staff_schedules sc2 ON sc2.staff_id=sc.staff_id AND sc2.day=sc.day+1 AND sc2.status<>'cancelled'
      JOIN shift_templates sh2 ON sh2.id=sc2.shift_id
      WHERE sc.status<>'cancelled' AND (sh2.cross_day=0 AND sh2.start_hour< ?)`).all(OPEN_HOUR + 1)
    for (const n of nights) {
      const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind='schedule_conflict' AND ref_id=? AND status='open'").get(n.next_shift)
      if (!exists) findings.push(recordFinding({
        kind: 'schedule_conflict', level: 'block', refType: 'schedule', refId: n.next_shift, day: n.next_day,
        title: `跨日疲劳冲突：${n.staff_name} 前夜夜班次日 ${n.next_start}:00 又排日班`,
        detail: `跨日夜班次日 ${OPEN_HOUR}:00 才下班，次日早于该时刻的排班无法到岗，应调班或取消`,
        expected: { earliestStart: OPEN_HOUR }, actual: { start: n.next_start }
      }))
    }
    return { ok: true }
  })

  const openCount = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE status='open'").get().n
  const blocks = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE status='open' AND level='block'").get().n
  if (logEvent && findings.length) {
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(ctx.tick(), ctx.day(), 'reconcile', '闭环一致性巡检发现异常',
        `巡检发现 ${findings.length} 项排班/预约/库存/财务口径偏差（严重 ${blocks} 项，已自愈 ${healed.length} 项），请在「客流调度闭环」页核对。`,
        blocks > 0 ? -1 : 0, 'active')
  }
  return { ok: true, found: findings.length, healed: healed.length, openCount, blocks }
}

export function listFindings({ status = 'open', limit = 100 } = {}) {
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM reconcile_findings ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM reconcile_findings WHERE status=? ORDER BY id DESC LIMIT ?').all(status, limit)
  return rows.map(f => ({ ...f, expected_obj: safeJson(f.expected), actual_obj: safeJson(f.actual) }))
}
const safeJson = s => { try { return JSON.parse(s) } catch { return null } }

export function ignoreFinding(id) {
  const r = db.prepare("UPDATE reconcile_findings SET status='ignored' WHERE id=? AND status='open'").run(id)
  return { ok: r.changes > 0 }
}

export function reconcileStats() {
  const open = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE status='open'").get().n
  const blocks = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE status='open' AND level='block'").get().n
  const healedToday = db.prepare('SELECT COUNT(*) n FROM reconcile_findings WHERE status=? AND heal_tick>?').get('healed', 0).n
  return { open, blocks, healedTotal: healedToday }
}

// ---------------- 库存/团单变化 → 预测快照 + 动态调度闭环联动 ----------------
// 由预约/组团模块在事务「成功提交后」触发（回滚不触发）；同一游戏小时去重，避免批处理风暴。
let lastDirtyTick = -1
let lastDirtyKind = ''
export function markFlowDirty(kind = 'inventory') {
  afterCommit(() => {
    const t = ctx.tick()
    // 同 tick 同类型合并；不同 tick（跨小时）必刷
    if (lastDirtyTick === t && lastDirtyKind === kind) return
    lastDirtyTick = t
    lastDirtyKind = kind
    try {
      refreshForecastSnapshots()
    } catch (e) {
      console.error('[flow] 库存变化后预测快照刷新失败（不影响主业务）:', e)
    }
    // 动态调度重排（仅动态模式开启时）：失败不影响主业务
    try { ctx.dispatchAfter?.(`${kind}变化驱动客流重排`) } catch { /* 调度失败不阻塞 */ }
  })
}

// 未来 horizon 天闭环总览（统一预测 + 缺口 + 巡检），供前端「客流调度闭环」页
export function closedLoopOverview({ horizon = 3, demandProvider = null } = {}) {
  const days = []
  for (let d = 0; d < horizon; d++) {
    const day = ctx.day() + d
    const fc = forecastForDay(day)
    const demand = demandProvider ? demandProvider(day) : null
    days.push({ day, forecast: fc, demand })
  }
  return {
    today: ctx.day(),
    forecast: forecastStats(),
    days,
    reconcile: reconcileStats()
  }
}

export const FLOW_CONST = { OPEN_HOUR, CLOSE_HOUR, HOURS_PER_DAY, RIDE_FLOW_WEIGHT, PENDING_GROUP_CONFIDENCE, FORECAST_DAYS }

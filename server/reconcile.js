import db, { getSetting, setSetting, tx } from './db.js'

// 统一一致性对账与修复闭环（排班 / 预约 / 会员 / 团单 / 财务）：
// 系统写操作本身全部走「事务 + 幂等 + 条件更新」，本模块是最后一道防线——
// 用单据事实（reservations / group_items / group_payments）重算各侧派生计数与账务，
// 发现漂移（历史版本/极端系统异常/手工改库）时：① 返回结构化差异 ② 日结/手动触发登记经营异常事件
// ③ 提供受控修复（计数以单据为准重算；僵尸爽约补退挂起作废；团账以明细+流水对账）。
// 原则：对账只读不写库；repair 才写，且逐类独立事务、幂等、全程留痕，绝不凭空改资金。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  logFinance: null,     // 修复不产生资金流，保留注入位（财务差异仅报告）
  logEvent: null        // (type,title,desc,impact) 经营异常事件登记，由 index.js 注入
}
export function initReconcileContext(deps = {}) { Object.assign(ctx, deps) }

// ---------------- ① 时段库存计数 vs 预约单据重算 ----------------
// 事实口径（与 reservations.js 全部写路径自洽）：
//   booked_count = Σ reservations.qty（booked / checked / noshow；refunded* 已释放，不计）
//   checked_count = Σ reservations.qty（status=checked）
//   noshow_count  = Σ reservations.qty（status=noshow）
// 注：团行程部分核销时关联 0 元预约单 qty 会随之缩减，故按单据求和即为真。
function slotFacts(slotId) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('booked','checked','noshow') THEN qty END),0) AS booked,
      COALESCE(SUM(CASE WHEN status='checked' THEN qty END),0) AS checked,
      COALESCE(SUM(CASE WHEN status='noshow' THEN qty END),0) AS noshow
    FROM reservations WHERE slot_id=?`).get(slotId)
  return { booked: row.booked, checked: row.checked, noshow: row.noshow }
}

// 全量/指定时段对账，返回漂移明细（只读）
export function auditSlots({ day = null, slotId = null } = {}) {
  const conds = []
  const args = []
  if (slotId) { conds.push('s.id=?'); args.push(num(slotId)) }
  if (day) { conds.push('s.day=?'); args.push(num(day)) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const slots = db.prepare(`SELECT s.* FROM reservation_slots s ${where} ORDER BY s.day,s.hour,s.id`).all(...args)
  const drifts = []
  for (const s of slots) {
    const f = slotFacts(s.id)
    const diff = {
      slot_id: s.id, scope: s.scope, ride_id: s.ride_id, day: s.day, hour: s.hour,
      status: s.status,
      stored: { booked: s.booked_count, checked: s.checked_count, noshow: s.noshow_count, refund: s.refund_count },
      facts: f,
      delta: { booked: f.booked - s.booked_count, checked: f.checked - s.checked_count, noshow: f.noshow - s.noshow_count }
    }
    if (diff.delta.booked !== 0 || diff.delta.checked !== 0 || diff.delta.noshow !== 0) drifts.push(diff)
  }
  return { ok: true, scanned: slots.length, driftCount: drifts.length, drifts }
}

// 修复时段计数：booked/checked/noshow 以单据重算值覆盖；refund_count 是累计量（历史不可重建），仅保留不动
export function repairSlots({ day = null, slotId = null, requestId = '' } = {}) {
  const audit = auditSlots({ day, slotId })
  let fixed = 0
  const fixedIds = []
  for (const d of audit.drifts) {
    tx(() => {
      db.prepare('UPDATE reservation_slots SET booked_count=?, checked_count=?, noshow_count=? WHERE id=?')
        .run(d.facts.booked, d.facts.checked, d.facts.noshow, d.slot_id)
      fixedIds.push(d.slot_id)
    })
    fixed++
  }
  if (fixed > 0 && ctx.logEvent) {
    ctx.logEvent('reservation', '库存对账修复 · 时段计数已重算',
      `一致性对账发现 ${fixed} 个时段的库存计数与预约单据不一致，已以单据为准重算（booked/checked/noshow），不涉及任何资金变动。请求号：${requestId || '-'}`, -1)
  }
  return { ok: true, fixed, slotIds: fixedIds, audit }
}

// ---------------- ② 超售补退挂起队列有效性 ----------------
// 两类僵尸挂起：
//   stale_reservation：挂起单已不在 booked（被核销/改签/退款/爽约）→ 重试不会再补退，应作废；
//   stale_slot_gone：预约仍 booked 但其时段已关闭且无任何更晚开放时段（异常滞留）→ 报告，交运营核查
//                     （正常引擎重试会持续尝试，不在此自动退款，避免误操作）。
export function auditPendingRefunds() {
  const rows = db.prepare(`SELECT p.*, r.status AS rsv_status, r.slot_day, r.slot_hour, r.scope
                           FROM reservation_pending_actions p
                           JOIN reservations r ON r.id=p.reservation_id
                           WHERE p.status='pending'`).all()
  const stale = []
  for (const p of rows) {
    if (p.rsv_status !== 'booked') {
      stale.push({ id: p.id, reservation_id: p.reservation_id, kind: 'reservation_gone',
        rsv_status: p.rsv_status, attempts: p.attempts, last_error: p.last_error })
    }
  }
  return { ok: true, pending: rows.length, staleCount: stale.length, stale }
}

// 作废僵尸挂起（预约已被他途处置）；逐单独立事务幂等
export function repairPendingRefunds() {
  const audit = auditPendingRefunds()
  let obsolete = 0
  for (const s of audit.stale) {
    tx(() => {
      const u = db.prepare("UPDATE reservation_pending_actions SET status='obsolete', updated_tick=? WHERE id=? AND status='pending'")
        .run(ctx.tick(), s.id)
      if (u.changes > 0) obsolete++
    })
  }
  if (obsolete > 0 && ctx.logEvent) {
    ctx.logEvent('reservation', '补退挂起队列对账 · 僵尸记录已作废',
      `对账发现 ${obsolete} 条超售补退挂起记录关联的预约已被核销/改签/退款处置，重试不会二次退款，已置为作废（obsolete）。`, 0)
  }
  return { ok: true, obsolete, audit }
}

// ---------------- ③ 团账：应收 / 净收款 / 流水合计 三角对账 ----------------
// 应收事实（以行程明细重算）：
//   未结清团（confirmed/settled/完成/爽约前）：Σ unit_price*(qty - refunded_qty)
//   （noshow 行程在爽约结案时已把应收冲减为已核销部分，refunded_qty 同步记账）
function groupReceivableFacts(gid) {
  const row = db.prepare(`SELECT
      COALESCE(SUM(unit_price * (qty - refunded_qty)),0) AS receivable,
      COALESCE(SUM(unit_price * checked_qty),0) AS checked_worth
    FROM group_items WHERE group_id=?`).get(gid)
  return { receivable: row.receivable, checkedWorth: row.checked_worth }
}

export function auditGroups({ status = null } = {}) {
  const conds = []
  const args = []
  if (status) { conds.push('status=?'); args.push(status) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const groups = db.prepare(`SELECT * FROM group_orders ${where} ORDER BY id`).all(...args)
  const drifts = []
  for (const g of groups) {
    const f = groupReceivableFacts(g.id)
    // 已取消/拒绝/待确认的团：无锁定名额与款项，应收应为 0（pending 提交时按全额建应收，确认前取消不产生资金，明细 pending 不参与事实）
    const skipReceivable = ['pending', 'cancelled', 'rejected'].includes(g.status)
    const payRow = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN kind IN ('deposit','balance') THEN amount END),0) AS inflow,
        COALESCE(SUM(CASE WHEN kind LIKE 'refund%' THEN -amount END),0) AS refunded,
        COALESCE(SUM(CASE WHEN kind IN ('fee','noshow') THEN amount END),0) AS fee
      FROM group_payments WHERE group_id=?`).get(g.id)
    const ledgerNet = g.deposit_amount + g.paid_balance - g.refunded_amount     // 团单表头净收款
    const paymentsNet = payRow.inflow - payRow.refunded                          // 流水重算净收款
    const d = {
      group_id: g.id, code: g.code, status: g.status,
      stored: { receivable: g.receivable_amount, deposit: g.deposit_amount, balance: g.paid_balance, refunded: g.refunded_amount, fee: g.fee_amount, net: ledgerNet },
      facts: { receivable: f.receivable, checkedWorth: f.checkedWorth, inflow: payRow.inflow, refunded: payRow.refunded, fee: payRow.fee, net: paymentsNet },
      delta: { receivable: 0, net: ledgerNet - paymentsNet, fee: g.fee_amount - payRow.fee }
    }
    if (!skipReceivable) d.delta.receivable = f.receivable - g.receivable_amount
    if (d.delta.receivable !== 0 || d.delta.net !== 0 || d.delta.fee !== 0) {
      if (skipReceivable) d.delta.receivable = 0
      if (d.delta.receivable !== 0 || d.delta.net !== 0 || d.delta.fee !== 0) drifts.push(d)
    }
  }
  return { ok: true, scanned: groups.length, driftCount: drifts.length, drifts }
}

// 团账修复：以行程明细重算应收；以流水重算净收款并按「订金/尾款」回填表头（不改任何现金）。
// 退款/没收已逐笔入流水与财务，表头仅为派生汇总，修复只对齐汇总口径。
export function repairGroups() {
  const audit = auditGroups()
  let fixed = 0
  for (const d of audit.drifts) {
    tx(() => {
      const pay = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN kind='deposit' THEN amount END),0) AS deposit,
          COALESCE(SUM(CASE WHEN kind='balance' THEN amount END),0) AS balance,
          COALESCE(SUM(CASE WHEN kind LIKE 'refund%' THEN -amount END),0) AS refunded,
          COALESCE(SUM(CASE WHEN kind IN ('fee','noshow') THEN amount END),0) AS fee
        FROM group_payments WHERE group_id=?`).get(d.group_id)
      const sets = []
      const vals = []
      if (d.delta.receivable !== 0) { sets.push('receivable_amount=?'); vals.push(d.facts.receivable) }
      if (d.delta.net !== 0) {
        sets.push('deposit_amount=?', 'paid_balance=?', 'refunded_amount=?')
        vals.push(pay.deposit, pay.balance, pay.refunded)
      }
      if (d.delta.fee !== 0) { sets.push('fee_amount=?'); vals.push(pay.fee) }
      if (!sets.length) return
      vals.push(d.group_id)
      db.prepare(`UPDATE group_orders SET ${sets.join(',')} WHERE id=?`).run(...vals)
    })
    fixed++
  }
  if (fixed > 0 && ctx.logEvent) {
    ctx.logEvent('groups', '团账对账修复 · 汇总口径已对齐',
      `一致性对账发现 ${fixed} 个团单的应收/净收款汇总与行程明细、账务流水不一致，已以明细与流水为准回填团单汇总（订金/尾款/退款/手续费），现金与逐条流水不变。`, -1)
  }
  return { ok: true, fixed, audit }
}

// ---------------- 全量对账（调度闭环每小时/日结消费） ----------------
// 轻量扫描：未来 HORIZON 天 + 当日全部时段（覆盖在途预约），挂起队列，活跃团单。
// 返回结构化结果，不写库；发现任一漂移时 count>0，由调用方决定告警/修复。
export function runAudit({ horizon = 3, includeGroups = true } = {}) {
  const today = ctx.day()
  const slotAudit = auditSlots({})
  // 仅保留有意义的漂移（全库历史时段也扫，但主要看今明后）
  const slotDriftAll = slotAudit.drifts
  const activeSlotDrift = slotDriftAll.filter(d => d.day >= today - 1)
  const pendingAudit = auditPendingRefunds()
  const groupAudit = includeGroups
    ? auditGroups({ status: null })
    : { driftCount: 0, drifts: [] }
  const activeGroupDrift = groupAudit.drifts
  const driftCount = activeSlotDrift.length + pendingAudit.staleCount + activeGroupDrift.length
  return {
    ok: true,
    tick: ctx.tick(),
    day: today,
    driftCount,
    slots: { scanned: slotAudit.scanned, driftTotal: slotDriftAll.length, drifts: activeSlotDrift },
    pendingRefunds: { pending: pendingAudit.pending, stale: pendingAudit.staleCount, items: pendingAudit.stale },
    groups: { scanned: groupAudit.scanned || 0, drift: activeGroupDrift.length, items: activeGroupDrift }
  }
}

// 一键受控修复（运营手动/必要时日结）：逐类独立事务，互不影响；返回各类修复计数
export function repairAll() {
  const slots = repairSlots({})
  const pending = repairPendingRefunds()
  const groups = repairGroups()
  return {
    ok: true,
    fixedSlots: slots.fixed,
    obsoletePending: pending.obsolete,
    fixedGroups: groups.fixed,
    fixedTotal: slots.fixed + pending.obsolete + groups.fixed
  }
}

// 最近对账结果（供前端轮询，不写库）
export function reconcileStats() {
  const r = runAudit({ includeGroups: true })
  return {
    driftCount: r.driftCount,
    slotDrift: r.slots.driftTotal,
    activeSlotDrift: r.slots.drifts.length,
    stalePending: r.pendingRefunds.stale,
    pendingRefunds: r.pendingRefunds.pending,
    groupDrift: r.groups.drift
  }
}

// 日结守卫：闭园时跑一次对账，存在漂移则登记经营异常事件（不自动修复资金侧，仅计数侧可由运营一键修复）
export function dayCloseAudit(day) {
  const r = runAudit({})
  if (r.driftCount > 0 && ctx.logEvent) {
    ctx.logEvent('reservation', '闭园一致性对账发现状态漂移',
      `第 ${day} 天闭园对账：时段库存漂移 ${r.slots.drifts.length} 处、僵尸补退挂起 ${r.pendingRefunds.stale} 条、团账汇总漂移 ${r.groups.drift} 个。` +
      `写操作均有事务与幂等保护，漂移通常来自历史版本升级；请在「客流预测 → 对账中心」查看明细并执行一键修复（计数以单据为准，不改资金）。`, -2)
  }
  return r
}

export { setSetting }

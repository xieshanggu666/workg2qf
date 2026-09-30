// 统一客流预测与资源调度闭环模块一致性测试：
// 统一预测（散客/团队/会员预约 + 设施折算 + 散客外推）、团队待确认置信折算、预测快照刷新、
// 库存变化事务提交后才触发联动（回滚不触发）、检修/投诉统一优先级排序、
// 一致性巡检（计数器漂移自愈/团账/跨日排班冲突/退款流水）、日结自适应学习
// 运行：node --test server/flow.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting, tx, afterCommit } = await import('./db.js')
const FLOW = await import('./flow.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')
const SCH = await import('./scheduling.js')

const finLogs = []
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: () => ({ id: 1, code: 'TS0001' })
})
G.initGroupContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: () => ({ id: 2, code: 'TS0002' })
})
RSV.initReservationContext({ handleParkOutageGroup: (rows, info) => G.handleParkOutageGroupRows(rows, info) })
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  complaintRoles: { queue: ['保安', '安保'], hygiene: ['保洁'], facility: ['维修'] }
})

let dirtyHits = []
FLOW.initFlowContext({ dispatchAfter: (reason) => dirtyHits.push(reason) })

function setClock(day, hour) {
  setSetting('day', day); setSetting('hour', hour)
  setSetting('tick', (day - 1) * 10 + (hour - 9))
}

before(() => {
  setClock(1, 9)
  setSetting('cash', 500000)
  setSetting('ticket', 100)
  setSetting('scheduleAutoFill', 0)   // 闭环测试中不自动排班，避免污染
  RSV.ensureSlots()
})

// ---------------- 统一客流预测 ----------------
test('统一预测：入园/设施预约计入预测；未来日含散客外推；今日散客不外推（引擎实时产生）', () => {
  RSV.ensureSlots()
  const day = 2
  // 明天 10 点入园时段直接占 60 个名额
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=10").get(day)
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count+60 WHERE id=?').run(slot.id)
  const f = FLOW.forecastForDay(day)
  const h10 = f.hours.find(h => h.hour === 10)
  assert.equal(h10.entry, 60)
  assert.ok(h10.flow >= 60)
  assert.ok(f.walkinForecast > 0, '未来日应有散客外推（无历史时走基准兜底）')
  // 今日散客预测为 0（散客由引擎实时产生，避免与实时客流重复计算）
  const today = FLOW.forecastForDay(1)
  assert.equal(today.walkinForecast, 0)
  // 清理
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count-60 WHERE id=?').run(slot.id)
})

test('团队名额统一入预测：已确认全额计入，待确认团单按置信度折算', () => {
  const r1 = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  const day = 3
  // 已确认团 10 人，入园 9 点
  const sub = G.submitGroup({ leader_name: '预测团A', qty: 10, itinerary: [
    { kind: 'entry', day, hour: 9 }, { kind: 'ride', ride_id: r1.id, day, hour: 10 }
  ], requestId: 'flow-ga-submit' })
  assert.equal(sub.ok, true)
  // 确认前（pending）：按 0.7 置信折算 → 四舍五入 7
  const before = FLOW.forecastForDay(day)
  assert.equal(before.groupEntry, 7, '待确认团单按 70% 置信计入')
  assert.equal(G.confirmGroup(sub.id, { requestId: 'flow-ga-confirm' }).ok, true)
  const after = FLOW.forecastForDay(day)
  assert.equal(after.groupEntry, 10, '确认后全额计入')
  // 库存口径：团队名额与散客共用同一时段（entry 已含团队，不重复）
  const h9 = after.hours.find(h => h.hour === 9)
  assert.equal(h9.entry, 10)
  assert.equal(h9.guestEntry, 0)
})

test('预测快照：刷新后落库且可查询；团单确认（事务提交后）自动刷新快照', () => {
  dirtyHits = []
  FLOW.refreshForecastSnapshots()
  const snap = db.prepare('SELECT * FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(3)
  assert.ok(snap)
  assert.ok(snap.predicted_flow > 0)
  // 再确认一个团（确认事务提交后应触发一次闭环联动）
  setClock(1, 12)   // 独立 tick，避免同 tick 同类型联动去重
  dirtyHits = []
  const r1 = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  const sub = G.submitGroup({ leader_name: '预测团B', qty: 8, itinerary: [
    { kind: 'entry', day: 2, hour: 14 }, { kind: 'ride', ride_id: r1.id, day: 2, hour: 15 }
  ], requestId: 'flow-gb-submit' })
  assert.equal(G.confirmGroup(sub.id, { requestId: 'flow-gb-confirm' }).ok, true)
  assert.ok(dirtyHits.some(r => String(r).includes('团队')), '团队确认提交后应触发闭环联动')
  const snap2 = db.prepare('SELECT group_entry FROM flow_forecast_snapshots WHERE day=2 AND hour=14').get()
  assert.equal(snap2.group_entry, 8)
})

// ---------------- 事务后联动：回滚不触发 ----------------
test('闭环联动只在事务提交后执行；事务回滚登记的联动被丢弃（库存/排班不被未生效变化驱动）', () => {
  RSV.ensureSlots()
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=2 AND hour=11").get()
  let fired = 0
  // 成功提交：触发
  tx(() => { afterCommit(() => fired++) })
  assert.equal(fired, 1)
  // 回滚：不触发
  assert.throws(() => tx(() => { afterCommit(() => fired++); throw new Error('rollback-me') }), /rollback-me/)
  assert.equal(fired, 1, '回滚事务的 afterCommit 不应执行')

  // 真实场景：下单事务回滚（库存不足）不会触发预测联动
  dirtyHits = []
  const cap = slot.capacity
  db.prepare('UPDATE reservation_slots SET booked_count=?, oversell=0 WHERE id=?').run(cap, slot.id)
  const bad = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 5, guest_name: '超卖', requestId: 'flow-oversell' })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'SLOT_FULL')
  assert.equal(dirtyHits.length, 0, '失败下单（已回滚）不应触发闭环重排')
  db.prepare('UPDATE reservation_slots SET booked_count=? WHERE id=?').run(0, slot.id)
})

// ---------------- 检修 / 投诉统一优先级 ----------------
test('优先级：紧急且临近 SLA 的投诉 > 一般投诉；检修中工单 > 排队工单', () => {
  const t = Number(getSetting('tick'))
  const mkComp = (severity, deadlineOffset, status = 'open', escalated = 0) => {
    const id = Number(db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source,escalated)
                                 VALUES('',?,1,'queue',?,'p','','','',?,?, 'manual',?)`)
      .run(t, severity, status, t + deadlineOffset, escalated).lastInsertRowid)
    return FLOW.complaintPriority(db.prepare('SELECT * FROM complaints WHERE id=?').get(id))
  }
  const urgentDueSoon = mkComp(3, 1)
  const normalLater = mkComp(1, 8)
  const escalated = mkComp(2, 8, 'open', 1)
  assert.ok(urgentDueSoon > normalLater, '紧急临期投诉优先级应高于一般投诉')
  assert.ok(escalated > normalLater, '升级过的投诉优先级应更高')

  const ride = db.prepare('SELECT * FROM rides ORDER BY id LIMIT 1').get()
  const processing = { status: 'processing', progress: 20 }
  const queued = { status: 'queued', progress: 0 }
  assert.ok(FLOW.maintenancePriority(processing) > FLOW.maintenancePriority(queued))
  // 引用 ride 避免未使用告警
  assert.ok(ride.id > 0)
})

test('需求画像按统一优先级排序：紧急投诉挂早班且排在班段投诉首位，驱动维修工补位', () => {
  setClock(40, 9)
  setSetting('scheduleMode', 'dynamic')
  // 清空第 40 天排班隔离
  db.prepare("UPDATE staff_schedules SET status='cancelled' WHERE day=40").run()
  // 先建一个一般保洁投诉（会被摊到非早班），再建紧急设施投诉（强制早班）
  const t0 = Number(getSetting('tick'))
  db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source)
              VALUES('TSTFLOW1',?,40,'hygiene',1,'一般卫生','','','','open',?,'manual')`).run(t0, t0 + 10)
  db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,content,target_type,target_id,status,deadline_tick,source)
              VALUES('TSTFLOW2',?,40,'facility',3,'紧急设施','','','','open',?,'manual')`).run(t0, t0 + 1)
  const d = SCH.demandForDay(40)
  const morning = d.bands.find(b => b.key === 'morning')
  const urgent = morning.complaints.find(c => c.code === 'TSTFLOW2')
  assert.ok(urgent, '紧急设施投诉应挂早班')
  // 班段内按统一优先级降序：TSTFLOW2 之前不得有更低优先级的投诉
  const idx = morning.complaints.findIndex(c => c.code === 'TSTFLOW2')
  assert.ok(idx >= 0)
  assert.ok(morning.complaints.slice(0, idx).every(c => c.priority > urgent.priority), '高优先级投诉应按分值排在前列')
  assert.ok(morning.need_repair >= 1, '紧急设施投诉应产生早班维修工需求')
})

// ---------------- 一致性巡检 ----------------
test('巡检：时段计数器漂移可被检测并自动自愈（仅改计数列，不动资金）', () => {
  setClock(1, 9)
  RSV.ensureSlots()
  const day = 3
  const slot = db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=9").get(day)
  assert.ok(slot, '未来时段库存应已生成')
  // 先正常下单 10 人（计数器与预约单一致）
  const booked = RSV.createReservation({ scope: 'entry', slotId: slot.id, qty: 10, guest_name: '对账', requestId: 'flow-heal-book' })
  assert.equal(booked.ok, true, booked.msg)
  const baseline = db.prepare('SELECT booked_count FROM reservation_slots WHERE id=?').get(slot.id).booked_count
  // 先收敛此前测试在其他时段可能留下的计数器偏差，隔离本用例
  FLOW.runReconcile({ autoHeal: true })
  // 人为制造漂移：booked_count 凭空 +5
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count+5 WHERE id=?').run(slot.id)
  const beforeOpen = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE ref_type='slot' AND ref_id=? AND status='open'").get(slot.id).n
  const r = FLOW.runReconcile({ autoHeal: true })
  assert.ok(r.found >= 1)
  const healedThisSlot = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE ref_type='slot' AND ref_id=? AND status='healed'").get(slot.id).n
  assert.ok(healedThisSlot >= 1, '该时段漂移应产生自愈记录')
  const fixed = db.prepare('SELECT booked_count FROM reservation_slots WHERE id=?').get(slot.id)
  assert.equal(fixed.booked_count, baseline, '计数器已按预约单事实源校正回真实值')
  // 再次巡检：该时段漂移已修复，不应再有 open 记录
  FLOW.runReconcile({ autoHeal: true })
  const still = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE ref_type='slot' AND ref_id=? AND status='open'").get(slot.id).n
  assert.equal(still, beforeOpen, '修复后不得重复报该时段漂移')
})

test('巡检：部分退团（预约 qty 收缩、refund_count 增加）属正常变化，不得被误判为计数器漂移反复自愈', () => {
  setClock(1, 9)
  RSV.ensureSlots()
  db.prepare("UPDATE rides SET status='operating'").run()
  db.prepare("UPDATE reservation_slots SET status='open' WHERE scope='ride'").run()
  const r1 = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  // 明天 10 点入园 + 11 点设施的 8 人团，确认后提前退 3 人
  const sub = G.submitGroup({ leader_name: '计数器对账团', qty: 8, itinerary: [
    { kind: 'entry', day: 2, hour: 10 }, { kind: 'ride', ride_id: r1.id, day: 2, hour: 11 }
  ], requestId: 'flow-counter-submit' })
  assert.equal(G.confirmGroup(sub.id, { requestId: 'flow-counter-confirm' }).ok, true)
  const rideItem = db.prepare("SELECT * FROM group_items WHERE group_id=? AND kind='ride'").get(sub.id)
  assert.equal(G.refundGroupLeg(rideItem.id, 3, { requestId: 'flow-counter-refund' }).ok, true)
  const items = db.prepare("SELECT * FROM group_items WHERE group_id=?").all(sub.id)
  const slotIds = items.map(i => i.slot_id)
  // 连续两轮巡检：本团的入园/设施时段均不得报告计数器漂移
  FLOW.runReconcile({ autoHeal: true })
  FLOW.runReconcile({ autoHeal: true })
  const bad = db.prepare(`SELECT COUNT(*) n FROM reconcile_findings WHERE kind='slot_counter' AND ref_id IN (${slotIds.map(() => '?').join(',')}) AND status='open'`)
    .get(...slotIds).n
  assert.equal(bad, 0, '部分退团后的 qty/refund 组合是正常口径，本团时段不应有漂移告警')
  // 计数器事实核对：设施时段名额释放 booked=5（8 预约 − 3 退款），不被巡检改写；退款人数记录在团行程上
  const slot = db.prepare('SELECT * FROM reservation_slots WHERE id=?').get(rideItem.slot_id)
  assert.equal(slot.booked_count, 5, '巡检不得把部分退团后的名额 5 自愈回 8')
  const itemAfter = db.prepare('SELECT * FROM group_items WHERE id=?').get(rideItem.id)
  assert.equal(itemAfter.refunded_qty, 3)
  const rsv = db.prepare('SELECT * FROM reservations WHERE id=?').get(rideItem.reservation_id)
  assert.equal(rsv.qty, 5)
})

test('巡检：跨日夜班次日早班硬冲突被识别为 block；无冲突时不误报', () => {
  setClock(50, 9)
  const night = db.prepare("SELECT * FROM shift_templates WHERE code='night'").get()
  const morning = db.prepare("SELECT * FROM shift_templates WHERE code='morning'").get()
  const guard = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 ORDER BY id LIMIT 1").get()
  // 第 50 天夜班 + 第 51 天早班（9 点前开始冲突）——夜班 17~次日9，早班 9~14
  SCH.createSchedule({ staffId: guard.id, shiftId: night.id, day: 50, requestId: 'flow-xday-1' })
  SCH.createSchedule({ staffId: guard.id, shiftId: morning.id, day: 51, requestId: 'flow-xday-2' })
  const r = FLOW.runReconcile({ autoHeal: true })
  assert.ok(r.found >= 1)
  const conflict = db.prepare("SELECT * FROM reconcile_findings WHERE kind='schedule_conflict' AND status='open'").all()
  assert.ok(conflict.some(c => c.day === 51 && c.level === 'block'), '应识别跨日疲劳冲突')
})

test('巡检：团账流水与团单金额一致时不误报；人为篡改团单字段后可检出', () => {
  setClock(1, 9)
  const r1 = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  const sub = G.submitGroup({ leader_name: '对账团', qty: 6, itinerary: [
    { kind: 'entry', day: 2, hour: 12 }, { kind: 'ride', ride_id: r1.id, day: 2, hour: 13 }
  ], requestId: 'flow-recon-submit' })
  assert.equal(G.confirmGroup(sub.id, { requestId: 'flow-recon-confirm' }).ok, true)
  // 一致状态：无团账告警
  FLOW.runReconcile({ autoHeal: true })
  const clean = db.prepare("SELECT COUNT(*) n FROM reconcile_findings WHERE kind='group_ledger' AND ref_id=? AND status='open'").get(sub.id).n
  assert.equal(clean, 0)
  // 篡改团单已收尾款字段（无对应流水）→ block 告警（系统不擅自改资金）
  db.prepare('UPDATE group_orders SET paid_balance=paid_balance+100 WHERE id=?').run(sub.id)
  FLOW.runReconcile({ autoHeal: true })
  const hit = db.prepare("SELECT * FROM reconcile_findings WHERE kind='group_ledger' AND ref_id=? AND status='open'").get(sub.id)
  assert.ok(hit && hit.level === 'block')
})

// ---------------- 日结自适应学习 ----------------
test('日结学习：回填实际客流与预测精度，EMA 调整散客外推系数（有基线时）', () => {
  const day = 60
  // 在第 58 天对「未来日」第 60 天生成预测（散客外推取 55~57 天真实散客均值）
  setClock(day - 2, 9)
  RSV.ensureSlots()
  // 制造历史 visitors（近 3 天 55/56/57，均为已结束日）以产生非 0 散客基线
  for (let d = day - 5; d <= day - 3; d++) {
    for (let h = 9; h <= 18; h++) {
      db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,500,80,40,0)')
        .run((d - 1) * 10 + (h - 9), d, h)
    }
  }
  FLOW.refreshForecastSnapshots()
  const before = db.prepare('SELECT * FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(day)
  assert.ok(before.walkin_forecast >= 500, '应有非 0 散客基线供学习')
  // 第 60 天实际入园：3 小时各 500（总 1500），其中预约核销入园 300 → 真实散客 1200
  for (const h of [9, 12, 15]) {
    db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,500,80,40,0)')
      .run((day - 1) * 10 + (h - 9), day, h)
  }
  db.prepare(`INSERT INTO reservations(code,guest_name,scope,ride_id,slot_id,slot_day,slot_hour,qty,amount,status,source,created_tick,created_day)
              VALUES('YYLEARN','学习','entry',NULL,NULL,?,9,300,0,'checked','auto',?,?)`)
    .run(day, Number(getSetting('tick')), day)
  // 跨日到第 61 天闭园结算：用第 60 天实际值学习
  setClock(day + 1, 9)
  const oldFactor = Number(getSetting('flowWalkinFactor') || 1)
  const r = FLOW.settleForecastLearning(day)
  assert.equal(r.ok, true)
  assert.notEqual(r.skipped, true)
  const snap = db.prepare('SELECT * FROM flow_forecast_snapshots WHERE day=? AND hour=0').get(day)
  assert.equal(snap.settled, 1)
  assert.equal(snap.actual_flow, 1500)
  assert.ok(snap.accuracy > 0)
  const newFactor = Number(getSetting('flowWalkinFactor'))
  assert.ok(newFactor > 0.5 && newFactor < 1.7)
  // 真实散客（1200）低于预测基线 → EMA 系数应向下调整
  assert.ok(newFactor < oldFactor, `散客高估时系数应下调：${oldFactor} → ${newFactor}`)
})

test('闭环总览结构：未来 N 天统一预测 + 需求画像 + 巡检统计', () => {
  setClock(1, 9)
  const ov = FLOW.closedLoopOverview({ horizon: 3, demandProvider: d => SCH.demandForDay(d) })
  assert.equal(ov.days.length, 3)
  assert.ok(ov.days[0].forecast)
  assert.ok(ov.days[0].demand.bands.length === 4)
  assert.ok(typeof ov.reconcile.open === 'number')
  assert.ok(ov.forecast.factor >= 0.6)
})

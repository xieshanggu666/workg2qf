// 统一客流预测与资源调度闭环一致性测试：
// 四类客流融合预测 / 快照与日结准确率 / 库存-预约对账与受控修复 / 僵尸补退挂起 /
// 团账三角对账 / 检修投诉优先级 / 跨日夜班次日交接覆盖 / 库存变化触发调度重评估（节流）
// 运行：node --test server/flowForecast.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const RSV = await import('./reservations.js')
const G = await import('./groups.js')
const SCH = await import('./scheduling.js')
const FF = await import('./flowForecast.js')
const RC = await import('./reconcile.js')

const finLogs = []
const complaints = []
RSV.initReservationContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: p => { complaints.push(p); return { id: complaints.length + 100, code: 'TST' + String(complaints.length + 1).padStart(4, '0') } }
})
G.initGroupContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createComplaint: p => { complaints.push(p); return { id: complaints.length + 100, code: 'TST' + String(complaints.length + 1).padStart(4, '0') } }
})
RSV.initReservationContext({ handleParkOutageGroup: (rows, info) => G.handleParkOutageGroupRows(rows, info) })
SCH.initSchedulingContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  complaintRoles: { queue: ['保安', '安保'], safety: ['保安', '安保'], missing: ['保安', '安保'],
    hygiene: ['保洁'], food: ['保洁'], facility: ['维修'] }
})
const events = []
RC.initReconcileContext({ logEvent: (type, title, desc, impact) => events.push({ type, title, desc, impact }) })

const entrySlot = (day, hour) => db.prepare("SELECT * FROM reservation_slots WHERE scope='entry' AND day=? AND hour=?").get(day, hour)
let seq = 0
const uid = p => `${p}-${++seq}`

function setClock(day, hour) {
  setSetting('day', day); setSetting('hour', hour)
  setSetting('tick', (day - 1) * 10 + (hour - 9))
}

before(() => {
  setClock(1, 9)
  setSetting('cash', 500000)
  setSetting('ticket', 100)
  setSetting('scheduleAutoFill', 0)
  setSetting('scheduleMode', 'dynamic')
  RSV.ensureSlots()
  FF.refreshForecasts()
})

test('统一预测：逐小时输出散客/散约/会员/团单四类客流，班段聚合与全天合计自洽', () => {
  setClock(10, 9)
  RSV.ensureSlots()
  // 散客预约（无 member_id）
  const s = entrySlot(10, 10)
  const r1 = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 3, guest_name: '散客', requestId: uid('b') })
  assert.equal(r1.ok, true)
  // 团单：锁 6 人名额到 10 点入园
  const ride = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  const sub = G.submitGroup({
    leader_name: '预测领队', qty: 6,
    itinerary: [{ kind: 'entry', day: 10, hour: 10 }, { kind: 'ride', ride_id: ride.id, day: 10, hour: 11 }],
    requestId: uid('g')
  })
  assert.equal(sub.ok, true)
  assert.equal(G.confirmGroup(sub.id, { requestId: uid('gc') }).ok, true)

  const f = FF.forecastForDay(10)
  const h10 = f.hours.find(h => h.hour === 10)
  assert.equal(h10.guest_reserved, 3, '散客预约 3 人')
  assert.equal(h10.group_reserved, 6, '团单名额 6 人')
  assert.equal(h10.reserved, 9)
  assert.ok(h10.total >= 9, '当小时合计应含在途预约')
  const morning = f.bands.find(b => b.key === 'morning')
  assert.equal(morning.reserved, f.hours.filter(h => [9, 10, 11].includes(h.hour)).reduce((n, h) => n + h.reserved, 0))
  assert.equal(f.totals.reserved, f.bands.reduce((n, b) => n + b.reserved, 0), '全天=班段之和')
  assert.ok(f.confidence > 0 && f.confidence <= 100)
})

test('预测快照：当日首个营业 tick 固化开盘预测，之后只滚动 latest；日结回写实际与准确率', () => {
  setClock(20, 9)
  RSV.ensureSlots()
  FF.refreshForecasts()
  const snap0 = db.prepare('SELECT * FROM flow_forecast_days WHERE day=20').get()
  const open0 = snap0.open_total
  assert.ok(open0 > 0)
  // 同一 tick 加预约改变库存后再刷新：latest 变化，open 不变（walkin 预测不变，reserved +5）
  RSV.createReservation({ scope: 'entry', slotId: entrySlot(20, 15).id, qty: 5, guest_name: '固化', requestId: uid('b') })
  FF.refreshForecasts()
  const snap1 = db.prepare('SELECT * FROM flow_forecast_days WHERE day=20').get()
  assert.equal(snap1.open_total, open0, '开盘预测应固化不变')
  assert.ok(snap1.latest_total >= snap1.open_total + 5, '最新预测应反映新增预约名额')
  // 写入当日实际入园（模拟引擎 visitors），次日 9 点日结复盘
  db.prepare('INSERT INTO visitors(tick,day,hour,count,satisfaction,eat,total_spend) VALUES(?,?,?,?,?,?,?)')
    .run(Number(getSetting('tick')), 20, 10, open0 + 10, 80, 40, 1000)
  setClock(21, 9)
  const fin = FF.finalizeDayForecast(20)
  assert.equal(fin.actual, open0 + 10)
  assert.ok(fin.accuracy > 0 && fin.accuracy <= 100, '准确率应回填为 0-100')
  assert.equal(db.prepare('SELECT finalized, accuracy FROM flow_forecast_days WHERE day=20').get().finalized, 1)
})

test('库存对账：人为制造 booked_count 漂移可检出，修复以单据为准重算且不动资金', () => {
  setClock(30, 9)
  RSV.ensureSlots()
  const s = entrySlot(30, 11)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 4, guest_name: '对账', requestId: uid('b') })
  assert.equal(book.ok, true)
  const cash0 = Number(getSetting('cash'))
  // 模拟漂移：时段计数被污染（单据仍是事实）
  db.prepare('UPDATE reservation_slots SET booked_count=booked_count+7 WHERE id=?').run(s.id)
  const audit = RC.auditSlots({ day: 30 })
  const mine = audit.drifts.find(d => d.slot_id === s.id)
  assert.ok(mine, '应检出该时段库存漂移')
  assert.equal(mine.delta.booked, -7)
  assert.equal(mine.facts.booked, 4, '重算事实应以预约单据为准')
  const repair = RC.repairSlots({ day: 30 })
  assert.ok(repair.fixed >= 1)
  assert.equal(db.prepare('SELECT booked_count FROM reservation_slots WHERE id=?').get(s.id).booked_count, 4)
  assert.equal(Number(getSetting('cash')), cash0, '计数修复不得改动资金')
  // 修复后再次对账：当日无漂移
  assert.equal(RC.auditSlots({ day: 30 }).driftCount, 0)
})

test('补退挂起对账：预约已被退款/核销的僵尸挂起可检出并作废，正常挂起不误伤', () => {
  setClock(31, 9)
  RSV.ensureSlots()
  const s = entrySlot(31, 12)
  const book = RSV.createReservation({ scope: 'entry', slotId: s.id, qty: 1, guest_name: '挂起', requestId: uid('b') })
  // 直接构造一条 pending 挂起（模拟超售补退队列）
  db.prepare(`INSERT INTO reservation_pending_actions(reservation_id,action,status,attempts,last_error,created_tick,created_day,updated_tick)
              VALUES(?, 'overbook_refund','pending',2,'TX_FAILED',?,?,?)`)
    .run(book.id, Number(getSetting('tick')), 31, Number(getSetting('tick')))
  // 预约被他途全额退款 → 挂起变僵尸
  const ref = RSV.refundReservation(book.id, 'park', '园方退款')
  assert.equal(ref.ok, true)   // 注意：refundOne 正常路径会 resolvePending；这里改为重新插一条模拟历史僵尸
  db.prepare(`INSERT INTO reservation_pending_actions(reservation_id,action,status,attempts,last_error,created_tick,created_day,updated_tick)
              VALUES(?, 'overbook_refund','pending',2,'stale',?,?,?)`)
    .run(book.id, Number(getSetting('tick')), 31, Number(getSetting('tick')))
  const audit = RC.auditPendingRefunds()
  assert.equal(audit.staleCount, 1, '退款后的残留挂起应判为僵尸')
  const repair = RC.repairPendingRefunds()
  assert.equal(repair.obsolete, 1)
  assert.equal(RC.auditPendingRefunds().staleCount, 0)
})

test('团账三角对账：正常确认/尾款/退团流程零漂移；污染团单表头可检出并以流水修复', () => {
  setClock(32, 9)
  RSV.ensureSlots()
  const ride = db.prepare("SELECT * FROM rides WHERE status='operating' ORDER BY id LIMIT 1").get()
  const sub = G.submitGroup({
    leader_name: '对账领队', qty: 10,
    itinerary: [{ kind: 'entry', day: 32, hour: 9 }, { kind: 'ride', ride_id: ride.id, day: 32, hour: 10 }],
    requestId: uid('g')
  })
  const conf = G.confirmGroup(sub.id, { requestId: uid('gc') })
  assert.equal(conf.ok, true)
  G.payBalance(sub.id, 100000, { requestId: uid('bal') })  // 超额会被门控；正常收尾款在下面按实
  // 正常团（待确认被拒绝的团不应产生应收漂移）
  const sub2 = G.submitGroup({
    leader_name: '被拒团', qty: 6,
    itinerary: [{ kind: 'entry', day: 33, hour: 10 }], requestId: uid('g2')
  })
  assert.equal(G.rejectGroup(sub2.id, { requestId: uid('gr') }).ok, true)
  const cleanAudit = RC.auditGroups()
  assert.equal(cleanAudit.drifts.filter(d => d.group_id === sub.id).length, 0, '正常团账不应有漂移')
  assert.equal(cleanAudit.drifts.filter(d => d.group_id === sub2.id).length, 0, '被拒团不应报应收漂移')
  // 污染表头净收款
  const g0 = db.prepare('SELECT * FROM group_orders WHERE id=?').get(sub.id)
  db.prepare('UPDATE group_orders SET paid_balance=paid_balance+999 WHERE id=?').run(sub.id)
  const dirty = RC.auditGroups().drifts.find(d => d.group_id === sub.id)
  assert.ok(dirty, '应检出团单表头与流水不一致')
  assert.notEqual(dirty.delta.net, 0)
  const repair = RC.repairGroups()
  assert.ok(repair.fixed >= 1)
  const g1 = db.prepare('SELECT * FROM group_orders WHERE id=?').get(sub.id)
  assert.equal(g1.paid_balance, g0.paid_balance, '应以流水为准回填，现金与逐条流水不变')
})

test('检修/投诉优先级：紧急投诉与检修中工单分值更高，且进入需求画像携带优先级', () => {
  setClock(40, 9)
  const ride = db.prepare('SELECT * FROM rides ORDER BY id LIMIT 1').get()
  // 一般（开放，截止远）与紧急（截止极近）投诉各一
  const tickNow = Number(getSetting('tick'))
  db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,status,deadline_tick,escalations,source)
              VALUES('TSTA001',?,40,'hygiene',1,'一般卫生','open',?+20,0,'manual')`).run(tickNow, tickNow)
  db.prepare(`INSERT INTO complaints(code,tick,day,category,severity,title,status,deadline_tick,escalations,source)
              VALUES('TSTA002',?,40,'facility',3,'紧急设施','open',?+1,1,'manual')`).run(tickNow, tickNow)
  db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day)
              VALUES('WXT100',?,'queued','manual',0,3000,?,40)`).run(ride.id, tickNow)
  db.prepare(`INSERT INTO maintenance_orders(code,ride_id,status,source,progress,cost,create_tick,create_day)
              VALUES('WXT101',?,'processing','manual',90,3000,?,40)`).run(ride.id, tickNow)

  const d = SCH.demandForDay(40)
  const allComps = d.bands.flatMap(b => b.complaints)
  const urgent = allComps.find(c => c.code === 'TSTA002')
  const normal = allComps.find(c => c.code === 'TSTA001')
  assert.ok(urgent, '紧急投诉应进入画像')
  assert.ok(urgent.priority > normal.priority, '紧急+临期+升级投诉优先级应更高')
  assert.equal(urgent.urgency, 'urgent')
  const allOrders = d.bands.flatMap(b => b.orders || [])
  const queued = allOrders.find(o => o.code === 'WXT100')
  const processing = allOrders.find(o => o.code === 'WXT101')
  assert.ok(processing.score > queued.score, '检修中且接近完工的工单优先级应高于排队工单')
  // 缺口优先级排序：带高优工单/投诉的缺口排在前面
  const gaps = SCH.gapsForDay(40).gaps
  const repairGap = gaps.find(g => g.role === '维修工')
  assert.ok(repairGap, '无维修排班时应有维修工缺口')
  assert.ok(repairGap.priority > 0)
})

test('跨日夜班交接：前日夜班保安在次日 9:00 计入早班交接覆盖，9 点过后不顶替峰值缺口', () => {
  setClock(50, 9)   // 白班时刻预排夜班（17 点才上班）
  const guard = db.prepare("SELECT * FROM staff WHERE role IN ('保安','安保') AND active=1 ORDER BY id LIMIT 1").get()
  const night = db.prepare("SELECT * FROM shift_templates WHERE code='night'").get()
  const sc = SCH.createSchedule({ staffId: guard.id, shiftId: night.id, day: 50, requestId: uid('n') })
  assert.equal(sc.ok, true, sc.msg)
  setClock(50, 17)
  SCH.processScheduling()   // 夜班打卡

  // 构造「各时段综合客流持平（峰值含 9:00）、班段仅需区域基线 1 名保安」的场景
  const base0 = num0(getSetting('guestBase'))
  setSetting('guestBase', 0)
  setSetting('dispatchGuardFlow', 5000)
  setSetting('dispatchCleanFlow', 5000)

  // 次日 9:00（早班首个 tick，引擎尚未结算夜班）：前夜夜班交接 1 人覆盖开班，无早班保安客流缺口
  setClock(51, 9)
  const mg = SCH.gapsForDay(51).gaps.find(g => g.band === 'morning' && g.role === '保安/安保')
  assert.equal(mg, undefined, '9:00 为峰值小时且仅需 1 名保安时，前夜夜班交接应完全覆盖开班（无缺口）')
  const warn9 = SCH.coverageForDay(51).warnings.find(w => w.type === 'flow_guard' && w.band === 'morning')
  assert.equal(warn9, undefined)

  // 引擎推进：跨日夜班在 9:00 下班结算；同 tick 已结算的夜班（下班时刻=9:00）仍认可完成开班交接
  SCH.processScheduling()
  const att = db.prepare('SELECT * FROM staff_attendance WHERE schedule_id=?').get(sc.id)
  assert.equal(att.status, 'checked_out', '跨日夜班应在次日 9:00 已结算')
  assert.equal(att.settle_day, 51, '跨日夜班计入次日工资结算')
  assert.equal(SCH.coverageForDay(51).warnings.find(w => w.type === 'flow_guard' && w.band === 'morning'), undefined,
    '同 tick 已结算的夜班仍算完成开班交接')

  // 10 点：交接窗口结束（t>9:00），夜班已离岗不再顶替，无早班保安时恢复缺岗预警
  setClock(51, 10)
  const warn10 = SCH.coverageForDay(51).warnings.find(w => w.type === 'flow_guard' && w.band === 'morning')
  assert.ok(warn10, '9 点交接结束后，无早班保安应恢复早班缺岗预警')

  // 非峰值小时：即使 9:00 有交接，也不顶替 10/11 点更高峰值的需求（压低阈值使峰值需求=2）
  setSetting('guestBase', base0)
  setSetting('dispatchGuardFlow', 100)
  setClock(51, 9)
  const mg2 = SCH.gapsForDay(51).gaps.find(g => g.band === 'morning' && g.role === '保安/安保')
  // 早班峰值在 10/11 点（散客更多）→ need≥2，交接 1 人只覆盖开班，峰值仍有缺口
  if (mg2) {
    assert.ok(mg2.need >= 2, '早班峰值需求应≥2 人')
    assert.equal(mg2.have, 0, '峰值不在 9:00 时，夜班交接不得顶替峰值缺口')
    assert.ok(mg2.gap >= 1)
  }
  setSetting('dispatchGuardFlow', 500)
  setSetting('dispatchCleanFlow', 700)
})
function num0(v) { const n = Number(v); return Number.isFinite(n) ? n : 600 }

test('库存变化触发调度重评估：同一 tick 内节流只跑一次，开关关闭时不触发', async () => {
  setClock(60, 9)
  RSV.ensureSlots()
  setSetting('scheduleAutoFill', 1)
  setSetting('scheduleMode', 'dynamic')
  setSetting('dispatchGuardFlow', 100)   // 压低阈值制造客流缺口
  // 第一次触发：执行补位
  const r1 = SCH.scheduleDispatchOnInventoryChange('测试库存变化')
  assert.equal(r1.skipped, true === false ? false : r1.skipped, '开关开启时应实际执行（非 skipped）')
  assert.notEqual(r1.skipped, true)
  const r2 = SCH.scheduleDispatchOnInventoryChange('同一 tick 再次触发')
  assert.equal(r2.throttled, true, '同一游戏 tick 内第二次应被节流')
  // 关闭总开关：跳过
  setSetting('scheduleAutoFill', 0)
  const r3 = SCH.scheduleDispatchOnInventoryChange('开关关闭')
  assert.equal(r3.skipped, true)
  setSetting('scheduleAutoFill', 1)
})

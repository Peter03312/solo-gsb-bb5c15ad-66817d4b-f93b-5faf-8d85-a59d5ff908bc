'use strict';
// 事件时间按实际时刻判定（分钟写法与带秒写法等价）端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证：
//   单条事件新增/更正：同设备同刻（如 09:00 与 09:00:00）冲突整次拒绝；
//   批次引用按实际时刻“严格更早”：同刻引用（两种写法互撞）拒绝；
//   断网整包补录：包内同刻冲突、包内同刻引用、与既有事件同刻冲突均整包回滚，
//     同号同内容重试仍幂等返回原结果；
//   换线预演与确认：整组后同刻冲突/同刻引用预演即拒绝，合法预演版本与编号约定不变；
//   非法变更不改事件及已产生的业务结论（放行仍有效、推导不变）；
//   合法异时变更仍按原规则重算；已有事件时间文本原样保留。
//   node scripts/test-time-instants.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39177';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-instants-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '全脂奶粉', allergens: ['乳'] });
    const EGG = await newId('/api/materials', { code: 'EGG', name: '全蛋液', allergens: ['蛋'] });
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '烘焙B线' });
    const state = async () => (await api('GET', '/api/state')).json;
    const eventCount = async () => (await state()).events.length;
    const batchByCode = (st, code) => st.batches.find((b) => b.code === code);
    let r;

    // ---------- 1. 单条新增：同设备同刻（分钟 vs 带秒）冲突 ----------
    console.log('1) 单条新增：同设备同刻两种写法判定为同一时刻');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: LINE,
      batch_code: 'P1', material_ids: [MILK], note: '分钟写法加工'
    });
    check('分钟写法加工事件受理', r.status === 200 && r.json.id, r.json);
    const P1_EVENT = r.json.id;

    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T09:00:00', equipment_id: LINE, note: '带秒同刻清洗'
    });
    check('同设备带秒同刻清洗 -> 400 时间冲突', r.status === 400 &&
      r.json.details && r.json.details.some((d) => d.includes('时间冲突')), r.json);
    check('冲突拒绝后事件数不变', (await eventCount()) === 1);

    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T09:30:00', equipment_id: LINE, note: '带秒写法清洗'
    });
    check('带秒写法清洗（异刻）受理', r.status === 200 && r.json.id, r.json);
    const CLEAN1 = r.json.id;

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:30', equipment_id: LINE,
      batch_code: 'PX', material_ids: [MILK]
    });
    check('分钟写法撞上既有带秒事件 -> 400 时间冲突', r.status === 400 &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);
    let st = await state();
    check('冲突加工不产生批次（无 PX）', !st.batches.some((b) => b.code === 'PX'), st.batches.map((b) => b.code));
    check('事件数仍为 2', (await eventCount()) === 2);

    // ---------- 2. 单条更正：同刻拒绝、原事件不变；异时合法 ----------
    console.log('2) 单条更正：同刻整次拒绝且原事件不变，异时合法更正受理');
    r = await api('PUT', `/api/events/${CLEAN1}`, {
      type: 'CLEAN', event_time: '2026-10-01T09:00', equipment_id: LINE, note: '改到分钟同刻'
    });
    check('更正到同刻（分钟写法撞 09:00）-> 400', r.status === 400 &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);
    st = await state();
    check('原清洗事件时间未改（仍 09:30:00）',
      st.events.find((e) => e.id === CLEAN1).event_time === '2026-10-01T09:30:00',
      st.events.find((e) => e.id === CLEAN1));

    r = await api('PUT', `/api/events/${CLEAN1}`, {
      type: 'CLEAN', event_time: '2026-10-01T09:45', equipment_id: LINE, note: '合法异时更正'
    });
    check('异时更正受理', r.status === 200 && r.json.ok === true, r.json);

    r = await api('PUT', `/api/events/${CLEAN1}`, {
      type: 'CLEAN', event_time: '2026-10-01T09:00:00', equipment_id: LINE, note: '改到带秒同刻'
    });
    check('更正到同刻（带秒写法撞 09:00）-> 400', r.status === 400 &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);
    st = await state();
    check('原清洗事件仍未改（仍 09:45）',
      st.events.find((e) => e.id === CLEAN1).event_time === '2026-10-01T09:45',
      st.events.find((e) => e.id === CLEAN1));

    // ---------- 3. 批次引用：同刻（两种写法互撞）不算“严格更早” ----------
    console.log('3) 批次引用按实际时刻严格更早：同刻引用两种写法互撞均拒绝');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00:00', equipment_id: LINE2,
      batch_code: 'P2', material_ids: [EGG], ref_batch_ids: [batchByCode(await state(), 'P1').id]
    });
    check('带秒同刻引用分钟写法批次 -> 400 未来或同时刻', r.status === 400 &&
      r.json.details.some((d) => d.includes('未来或同时刻')), r.json);
    check('同刻引用不产生批次（无 P2）',
      !(await state()).batches.some((b) => b.code === 'P2'));

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00:30', equipment_id: LINE2,
      batch_code: 'P2', material_ids: [EGG], note: '带秒异刻加工'
    });
    check('带秒异刻加工受理', r.status === 200 && r.json.id, r.json);
    const P2_EVENT = r.json.id;
    const P2_BATCH = batchByCode(await state(), 'P2').id;

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00:30', equipment_id: LINE,
      batch_code: 'P3', material_ids: [], ref_batch_ids: [P2_BATCH]
    });
    check('同刻同写法引用 -> 400', r.status === 400 &&
      r.json.details.some((d) => d.includes('未来或同时刻')), r.json);

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:01', equipment_id: LINE,
      batch_code: 'P3', material_ids: [], ref_batch_ids: [P2_BATCH], note: '严格更晚，合法引用'
    });
    check('严格更晚引用受理（合法异时变更）', r.status === 200 && r.json.id, r.json);
    st = await state();
    const p3 = batchByCode(st, 'P3');
    check('合法变更仍按原规则重算：P3 含引用批次的蛋',
      p3 && p3.allergens.includes('蛋'), p3 && p3.allergens);
    check('P3 同时含设备残留的乳（推导联动正常）',
      p3 && p3.allergens.includes('乳'), p3 && p3.allergens);

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00:00', equipment_id: LINE2,
      batch_code: 'P4', material_ids: [MILK], note: '带秒写法产出'
    });
    check('带秒写法产出 P4 受理', r.status === 200 && r.json.id, r.json);
    const P4_BATCH = batchByCode(await state(), 'P4').id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-02T09:00', equipment_id: LINE,
      batch_code: 'P5', material_ids: [], ref_batch_ids: [P4_BATCH]
    });
    check('分钟同刻引用带秒写法批次 -> 400 未来或同时刻', r.status === 400 &&
      r.json.details.some((d) => d.includes('未来或同时刻')), r.json);
    check('同刻引用不产生批次（无 P5）',
      !(await state()).batches.some((b) => b.code === 'P5'));

    // ---------- 4. 非法变更不改已产生的业务结论 ----------
    console.log('4) 非法变更整次拒绝：事件与已产生的业务结论（放行）不变');
    const P3_BATCH = batchByCode(await state(), 'P3').id;
    r = await api('POST', '/api/releases', {
      batch_id: P3_BATCH, released_at: '2026-10-01T10:00', released_by: '质检员-王敏'
    });
    check('P3 放行登记成功', r.status === 200 && r.json.id, r.json);
    const REL3 = r.json.id;
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T09:01:00', equipment_id: LINE, note: '带秒同刻撞 P3'
    });
    check('同刻清洗（撞 P3 的 09:01）-> 400', r.status === 400 &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);
    st = await state();
    const rel3 = batchByCode(st, 'P3').releases.find((x) => x.id === REL3);
    check('非法变更后放行仍有效', rel3 && rel3.status === 'ACTIVE', rel3);
    check('非法变更后 P3 推导不变',
      batchByCode(st, 'P3').allergens.join(',') === p3.allergens.join(','),
      batchByCode(st, 'P3').allergens);

    // ---------- 5. 断网整包补录：同刻冲突/同刻引用整包回滚；同内容重试幂等 ----------
    console.log('5) 断网整包补录：同刻判定与整包回滚、幂等约定');
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CONFLICT',
      records: [
        { external_ref: 'L-1', type: 'CLEAN', event_time: '2026-10-03T08:00', equipment_id: LINE },
        { external_ref: 'L-2', type: 'PROCESS', event_time: '2026-10-03T08:00:00', equipment_id: LINE,
          batch_code: 'BFC1', material_inputs: [{ material_id: MILK }] }
      ]
    });
    check('包内同设备同刻（两种写法）-> 400 BACKFILL_REJECTED',
      r.status === 400 && r.json.code === 'BACKFILL_REJECTED' &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);
    r = await api('GET', '/api/backfills/BF-CONFLICT');
    check('整包回滚：不写补录台账', r.status === 404 && r.json.code === 'BACKFILL_NOT_FOUND', r.json);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-INPKG-REF',
      records: [
        { external_ref: 'R-1', type: 'PROCESS', event_time: '2026-10-03T09:00', equipment_id: LINE,
          batch_code: 'BFA', material_inputs: [{ material_id: MILK }] },
        { external_ref: 'R-2', type: 'PROCESS', event_time: '2026-10-03T09:00:00', equipment_id: LINE2,
          batch_code: 'BFB', material_inputs: [], ref_batch_codes: ['BFA'] }
      ]
    });
    check('包内同刻引用（分钟->带秒）-> 400 整包拒绝',
      r.status === 400 && r.json.code === 'BACKFILL_REJECTED' &&
      r.json.details.some((d) => d.includes('不早于')), r.json);
    r = await api('GET', '/api/backfills/BF-INPKG-REF');
    check('整包回滚：不写补录台账', r.status === 404, r.json);

    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-EXISTING-REF',
      records: [
        { external_ref: 'X-1', type: 'PROCESS', event_time: '2026-10-01T09:00:00', equipment_id: LINE2,
          batch_code: 'BFC', material_inputs: [], ref_batch_codes: ['P1'] }
      ]
    });
    check('补录记录同刻引用既有批次 -> 400 BACKFILL_REJECTED',
      r.status === 400 && r.json.code === 'BACKFILL_REJECTED' &&
      r.json.details.some((d) => d.includes('未来或同时刻')), r.json);
    r = await api('GET', '/api/backfills/BF-EXISTING-REF');
    check('整包回滚：不写补录台账', r.status === 404, r.json);
    check('三次失败补录后事件数不变', (await eventCount()) === 5);

    const bfOkBody = {
      backfill_code: 'BF-OK',
      records: [
        { external_ref: 'OK-1', type: 'PROCESS', event_time: '2026-10-03T10:00', equipment_id: LINE,
          batch_code: 'BFD', material_inputs: [{ material_id: MILK }] },
        { external_ref: 'OK-2', type: 'CLEAN', event_time: '2026-10-03T10:30:00', equipment_id: LINE,
          note: '带秒写法清洗' }
      ]
    };
    r = await api('POST', '/api/backfills', bfOkBody);
    check('合法补录包（分钟+带秒混合）受理', r.status === 200 && r.json.ok === true, r.json);
    const bfOkEvents = r.json.events;
    r = await api('POST', '/api/backfills', bfOkBody);
    check('同号同内容重试 -> 200 幂等返回原结果',
      r.status === 200 && r.json.idempotent === true &&
      JSON.stringify(r.json.events) === JSON.stringify(bfOkEvents), r.json);
    check('幂等重试不新增事件', (await eventCount()) === 7);

    // ---------- 6. 换线预演与确认：同刻判定；版本与编号约定不变 ----------
    console.log('6) 换线预演/确认：整组后同刻冲突与同刻引用拒绝，合法预演约定不变');
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'insert_clean', event_time: '2026-10-01T09:00:00', equipment_id: LINE, note: '同刻预演' }
      ]
    });
    check('预演拟插入同刻清洗 -> 400 REPLAN_REJECTED',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED' &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);

    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: P2_EVENT, type: 'PROCESS', event_time: '2026-10-01T09:01:00',
          equipment_id: LINE2, batch_code: 'P2', material_ids: [EGG], ref_batch_ids: [] }
      ]
    });
    check('预演把被引用批次改到与引用者同刻 -> 400 REPLAN_REJECTED',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED' &&
      r.json.details.some((d) => d.includes('未来或同时刻')), r.json);

    const legalChanges = [
      { op: 'insert_clean', client_key: 'mid', event_time: '2026-10-01T09:00:45',
        equipment_id: LINE2, note: '带秒写法拟插入清洗' }
    ];
    r = await api('POST', '/api/replan/preview', { changes: legalChanges });
    check('合法预演（带秒写法）返回版本与拟插入编号',
      r.status === 200 && r.json.ok === true && typeof r.json.version === 'string' &&
      r.json.inserted_clean_events.length === 1, r.json);
    const version = r.json.version;
    const previewInsertId = r.json.inserted_clean_events[0].event_id;
    check('预演不写正式数据（事件数仍 7）', (await eventCount()) === 7);

    r = await api('POST', '/api/replan/apply', { version, changes: legalChanges });
    check('确认应用成功且编号与预演一致',
      r.status === 200 && r.json.ok === true &&
      r.json.inserted_clean_events[0].event_id === previewInsertId, r.json);
    st = await state();
    check('应用后事件落库（8 条）', st.events.length === 8, st.events.length);
    check('应用后按原规则重算：P4 残留中的蛋被清洗截断',
      batchByCode(st, 'P4').allergens.join(',') === '乳', batchByCode(st, 'P4').allergens);
    const rel3After = batchByCode(st, 'P3').releases.find((x) => x.id === REL3);
    check('P3 放行不受换线影响仍有效', rel3After && rel3After.status === 'ACTIVE', rel3After);

    r = await api('PUT', `/api/events/${CLEAN1}`, {
      type: 'CLEAN', event_time: '2026-10-01T09:46', equipment_id: LINE, note: '占位'
    });
    check('还原前置：清洗改到 09:46 受理', r.status === 200, r.json);
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: CLEAN1, type: 'CLEAN', event_time: '2026-10-01T09:00',
          equipment_id: LINE, note: '预演更正到同刻' }
      ]
    });
    check('预演更正既有事件到同刻（分钟写法）-> 400 REPLAN_REJECTED',
      r.status === 400 && r.json.code === 'REPLAN_REJECTED' &&
      r.json.details.some((d) => d.includes('时间冲突')), r.json);

    // ---------- 7. 已有事件时间文本原样保留 ----------
    console.log('7) 已有事件时间文本保留（存储与展示不改写）');
    st = await state();
    const timeOf = (id) => st.events.find((e) => e.id === id).event_time;
    check('分钟写法事件文本保留 2026-10-01T09:00', timeOf(P1_EVENT) === '2026-10-01T09:00', timeOf(P1_EVENT));
    check('带秒写法事件文本保留 2026-10-01T09:00:30', timeOf(P2_EVENT) === '2026-10-01T09:00:30', timeOf(P2_EVENT));
    check('更正后文本保留 2026-10-01T09:46', timeOf(CLEAN1) === '2026-10-01T09:46', timeOf(CLEAN1));
    const bfClean = st.events.find((e) => e.note === '带秒写法清洗' && e.type === 'CLEAN');
    check('补录带秒文本保留 2026-10-03T10:30:00',
      bfClean && bfClean.event_time === '2026-10-03T10:30:00', bfClean);
    const inserted = st.events.find((e) => e.note === '带秒写法拟插入清洗');
    check('换线插入事件文本保留 2026-10-01T09:00:45',
      inserted && inserted.event_time === '2026-10-01T09:00:45', inserted);

    // ---------- 汇总 ----------
    console.log('');
    if (failures) {
      console.error(`共 ${failures} 项未通过`);
      process.exitCode = 1;
    } else {
      console.log('全部通过');
    }
  } finally {
    proc.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

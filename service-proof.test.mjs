import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from './source-server.mjs';
import { addWorkdays, localDateOf } from './src/calendar.mjs';
import { ServiceProofEngine } from './src/engine.mjs';
import { fetchOverview, fetchSourceRecords, switchStage } from './src/ingest.mjs';
import { buildWorkbench } from './src/workbench.mjs';

const RULE = { workDays: [1, 2, 3, 4, 5], holiday: ['2026-11-23'] };

test('送达事件本地日期按登记时区取日', () => {
  assert.equal(localDateOf('2026-11-21T00:10:00+09:00', '+09:00'), '2026-11-21');
  assert.equal(localDateOf('2026-11-21T00:10:00+09:00', '+08:00'), '2026-11-20');
  assert.equal(localDateOf('2026-11-19T23:55:00+08:00', '+08:00'), '2026-11-19');
});

test('期限按送达日后五个工作日，节假日不计入', () => {
  // 2026-11-19 周四：20(五) → 24(二) → 25 → 26 → 27(五)，23 日节假日跳过
  assert.equal(addWorkdays('2026-11-19', 5, RULE), '2026-11-27');
  // 2026-11-20 周五与 2026-11-21 周六起算均落在 11-30（周一）
  assert.equal(addWorkdays('2026-11-20', 5, RULE), '2026-11-30');
  assert.equal(addWorkdays('2026-11-21', 5, RULE), '2026-11-30');
  assert.equal(addWorkdays('2026-11-23', 1, RULE), '2026-11-24');
});

test('跨区送达演练：回执合成、补送授权、期限冲突交人工', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const overview = await fetchOverview(url);
  const engine = new ServiceProofEngine({ today: '2026-11-20' });
  const stages = {};
  for (let stage = 1; stage <= overview.stages; stage += 1) {
    await switchStage(url, stage);
    for (const name of overview.sources) {
      engine.ingestAll(name, await fetchSourceRecords(url, name), stage);
    }
    engine.reconcile();
    engine.issueEligibleReservice();
    stages[stage] = buildWorkbench(engine);
  }

  // 全部来源记录各收一次（来源记录键去重）
  assert.equal(engine.records.length, 12);

  // ---- 阶段 1：交寄不证明到达，封面开启不足为凭 ----
  const s1 = stages[1];
  assert.deepEqual(s1.servable.map((x) => x.party).sort(), ['P-A', 'P-B']);
  assert.equal(s1.effective.length, 0);
  assert.equal(s1.adjudication.length, 0);
  assert.deepEqual(s1.undelivered.map((x) => x.party).sort(), ['P-A', 'P-B']);
  // P-B 的封面开启被退回并说明理由
  assert.ok(s1.servable.find((x) => x.party === 'P-B').rejected.some((r) => r.reason.includes('封面')));
  // 送达席按当前有效地址补送：P-A 改用新地址代理站，P-B 仍在联络处
  assert.equal(s1.orders.length, 2);
  const [orderA1, orderB1] = s1.orders;
  assert.equal(orderA1.party, 'P-A');
  assert.equal(orderA1.point, '代理站');
  assert.equal(orderA1.agent, 'R-Q');
  assert.equal(orderA1.state, '待发');
  assert.equal(orderB1.party, 'P-B');
  assert.equal(orderB1.point, '联络处');
  assert.equal(orderB1.state, '待发');

  // ---- 阶段 2：本人逐件确认独立成立，已交承运的补送转待撤 ----
  const s2 = stages[2];
  assert.deepEqual(s2.effective.map((x) => x.party), ['P-A']);
  const effA2 = s2.effective[0];
  assert.equal(effA2.since, '2026-11-21'); // 确认时间 00:10+09:00 按当地时区取 21 日
  assert.equal(effA2.due, '2026-11-30');
  assert.equal(effA2.basis.kind, '本人逐件确认');
  assert.equal(effA2.basis.point, '代理站');
  // 补送单 R1 已被承运交寄记录认领（袋号 B7），送达证实后转待撤，记录保留
  const [orderA2, orderB2] = s2.orders;
  assert.deepEqual(orderA2.history.map((h) => h.state), ['待发', '已交承运', '待撤']);
  assert.equal(orderA2.bag, 'B7');
  // P-B 仍未送达，其补送单不受 P-A 送达影响
  assert.deepEqual(s2.servable.map((x) => x.party), ['P-B']);
  assert.equal(orderB2.state, '待发');
  assert.deepEqual(s2.undelivered.map((x) => x.party), ['P-B']);
  assert.equal(s2.adjudication.length, 0);

  // ---- 阶段 3：期限通知与登记送达事实一致，可从通知定位起算 ----
  const s3 = stages[3];
  assert.equal(s3.deadlineTraces.length, 1);
  const trace3 = s3.deadlineTraces[0];
  assert.equal(trace3.docKey, 'M2/P11#2');
  assert.equal(trace3.noticedDue, '2026-11-30');
  assert.equal(trace3.basis.localDate, '2026-11-21');
  assert.equal(trace3.basis.point, '代理站');
  assert.equal(trace3.status, '一致');
  assert.equal(s3.adjudication.length, 0);

  // ---- 阶段 4：晚录入的旧地址回执按实际发生日认定 ----
  const s4 = stages[4];
  // 门房签收 + 同一主体清单回读合成一次送达，本地日期为发生的 19 日而非录入日
  const effA4 = s4.effective.find((x) => x.party === 'P-A');
  assert.equal(effA4.since, '2026-11-19');
  assert.equal(effA4.basis.kind, '门房签收+清单回读');
  assert.equal(effA4.basis.point, '联络处');
  assert.equal(effA4.basis.agent, 'R-H');
  // 同一文书再送不产生两份正在生效的办复义务：两次送达事件，只有一份义务
  assert.equal(effA4.events.length, 2);
  assert.equal(effA4.due, '2026-11-27'); // 已证实有效的早一次送达决定首次期限
  // 期限通知：待决期限更新，已通知的答复窗口不被缩短，冲突交人工确认
  const trace4 = s4.deadlineTraces[0];
  assert.equal(trace4.status, '待人工确认');
  assert.equal(trace4.noticedDue, '2026-11-30'); // 已通知窗口不变
  assert.equal(trace4.pendingDue, '2026-11-27'); // 待决期限按更早送达更新
  assert.equal(trace4.basis.localDate, '2026-11-21'); // 通知发出时的起算依据保留
  assert.equal(trace4.currentFirst.localDate, '2026-11-19');
  const conflictTypes = s4.adjudication.map((c) => c.type).sort();
  assert.deepEqual(conflictTypes, ['期限通知冲突', '迟到旧址回执']);
  // 已交承运的补送显示待撤，不能抹去；未寄出的他人补送不受同地址签收影响
  const [orderA4, orderB4] = s4.orders;
  assert.equal(orderA4.state, '待撤');
  assert.equal(orderB4.state, '待发');
  assert.deepEqual(s4.servable.map((x) => x.party), ['P-B']);
  // 同地址的门房签收不能替代 P-B 的逐件证明，其补送不被停掉
  const pb = s4.servable.find((x) => x.party === 'P-B');
  assert.ok(pb.rejected.some((r) => r.reason.includes('清单回读')));
  assert.deepEqual(s4.undelivered.map((x) => x.party), ['P-B']);
  // 已生效项不再自动补送：补送单总数不变
  assert.equal(engine.orders.length, 2);
  // 台账保留主体、文书版本与送达事件本地日期的对应
  assert.deepEqual(
    s4.ledger.map((l) => [l.party, l.docKey, l.localDate, l.point]),
    [
      ['P-A', 'M2/P11#2', '2026-11-19', '联络处'],
      ['P-A', 'M2/P11#2', '2026-11-21', '代理站'],
    ],
  );
});

test('来源记录重复到达时只收一次', async (t) => {
  const { server, url } = await start();
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  const engine = new ServiceProofEngine({ today: '2026-11-20' });
  const records = await fetchSourceRecords(url, 'clerk');
  assert.equal(engine.ingestAll('clerk', records, 1), records.length);
  assert.equal(engine.ingestAll('clerk', records, 1), 0);
  assert.equal(engine.records.length, records.length);
});

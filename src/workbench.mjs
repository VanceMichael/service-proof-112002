// 承办人工作台视图：可补送清单、已生效项、待人工裁决、补送单、
// 期限通知追踪、实际未送达清单与送达台账。

import { ORDER_STATE } from './engine.mjs';

const OPEN_STATES = new Set([ORDER_STATE.PENDING, ORDER_STATE.POSTED, ORDER_STATE.RECALLING]);

export function buildWorkbench(engine) {
  const view = engine.derive();
  // 工作台是时点快照：补送单复制一份，后续状态变化不改写已生成的视图。
  const snapshotOf = new Map(engine.orders.map((o) => [o, { ...o, history: o.history.map((h) => ({ ...h })) }]));
  const snapOrders = [...snapshotOf.values()];
  const tracesByItem = new Map();
  for (const trace of view.deadlineTraces) {
    const key = `${trace.docKey}::${trace.party}`;
    if (!tracesByItem.has(key)) tracesByItem.set(key, []);
    tracesByItem.get(key).push(trace);
  }

  const servable = [];
  const effective = [];
  for (const item of view.items) {
    const orders = snapOrders.filter((o) => o.party === item.party && o.docKey === item.docKey);
    const openOrder = orders.find((o) => OPEN_STATES.has(o.state)) ?? null;
    const traces = tracesByItem.get(`${item.docKey}::${item.party}`) ?? [];
    if (item.obligation) {
      effective.push({
        party: item.party,
        docKey: item.docKey,
        since: item.obligation.since,
        due: item.obligation.due,
        basis: item.obligation.basis,
        events: item.events,
        traces,
        orders,
      });
    } else {
      servable.push({
        party: item.party,
        docKey: item.docKey,
        address: engine.currentAddress(item.party, view.addresses),
        openOrder,
        rejected: item.rejected,
      });
    }
  }

  return {
    today: view.today,
    servable,           // 可补送的人和文书
    effective,          // 已生效、不能再自动补送的项目
    adjudication: view.conflicts, // 应交人工裁决的相冲突回执
    orders: snapOrders,           // 补送单（只增不删）
    deadlineTraces: view.deadlineTraces,
    undelivered: view.undelivered,
    ledger: view.ledger,
  };
}

const formatEvent = (e) => `${e.localDate} @${e.point ?? '未知地点'} · ${e.kind} · 代理 ${e.agent ?? '—'}`;

const formatOrder = (o) => {
  const trail = o.history.map((h) => h.state).join(' → ');
  const bag = o.bag ? ` · 袋号 ${o.bag}` : '';
  return `${o.id} · ${o.party} · ${o.docKey} → ${o.point}（${o.agent}）· 状态：${o.state}${bag} · 历程：${trail}`;
};

export function renderWorkbench(wb, { stage, issued = [] } = {}) {
  const lines = [];
  lines.push(`=== 回放阶段 ${stage} · 送达工作台（参考日 ${wb.today}）===`);

  lines.push('【可补送 · 无有效送达】');
  if (wb.servable.length === 0) lines.push('  （无）');
  for (const s of wb.servable) {
    const address = s.address
      ? `${s.address.point}（${s.address.agent}，资格 ${s.address.valid[0]}~${s.address.valid[1]}）`
      : '无当前有效地址，需人工处理';
    const order = s.openOrder ? `补送单 ${s.openOrder.id} ${s.openOrder.state}` : '尚无补送单';
    lines.push(`  - ${s.party} · ${s.docKey} · 当前有效地址：${address} · ${order}`);
    for (const r of s.rejected) lines.push(`    · 不足为凭：${r.kind} — ${r.reason}`);
  }

  lines.push('【已生效 · 不再自动补送】');
  if (wb.effective.length === 0) lines.push('  （无）');
  for (const e of wb.effective) {
    const noticed = e.traces.map((t) => `已通知截止 ${t.noticedDue}（${t.status}）`).join('；');
    lines.push(`  - ${e.party} · ${e.docKey} · 首次有效送达 ${e.since} @${e.basis.point}（${e.basis.kind}，代理 ${e.basis.agent}）· 待决期限 ${e.due}${noticed ? ` · ${noticed}` : ''}`);
    for (const ev of e.events) lines.push(`    · 送达事件：${formatEvent(ev)}`);
  }

  lines.push('【待人工裁决】');
  if (wb.adjudication.length === 0) lines.push('  （无）');
  for (const c of wb.adjudication) lines.push(`  - [${c.type}] ${c.note ?? c.reason ?? ''}`);

  lines.push('【补送单】');
  if (wb.orders.length === 0) lines.push('  （无）');
  for (const o of wb.orders) lines.push(`  - ${formatOrder(o)}`);
  for (const o of issued) lines.push(`  · 本阶段发出：${o.id} → ${o.party} ${o.point}（${o.agent}）`);

  lines.push('【期限通知追踪】');
  if (wb.deadlineTraces.length === 0) lines.push('  （无）');
  for (const t of wb.deadlineTraces) {
    lines.push(`  - 通知 ${t.record} · ${t.party} · ${t.docKey} · 发出 ${t.issued} · 通知截止 ${t.noticedDue}`);
    if (t.basis) lines.push(`    起算依据：${t.basis.localDate} @${t.basis.point}（${t.basis.kind}，${t.basis.agent}）→ 截止 ${t.basis.due}`);
    if (t.currentFirst) lines.push(`    当前最早有效送达：${t.currentFirst.localDate} @${t.currentFirst.point}（${t.currentFirst.kind}，${t.currentFirst.agent}）→ 待决期限 ${t.pendingDue} · 状态：${t.status}`);
  }

  lines.push('【实际未送达】');
  if (wb.undelivered.length === 0) lines.push('  （无）');
  for (const u of wb.undelivered) {
    lines.push(`  - ${u.party} · ${u.docKey}`);
    for (const r of u.rejected) lines.push(`    · ${r.kind}：${r.reason}`);
  }

  lines.push('【台账 · 主体 / 文书版本 / 送达事件本地日期】');
  if (wb.ledger.length === 0) lines.push('  （无）');
  for (const l of wb.ledger) lines.push(`  - ${l.party} · ${l.docKey} · ${l.localDate} · ${l.point} · ${l.kind}（${l.record}）`);

  return lines.join('\n');
}

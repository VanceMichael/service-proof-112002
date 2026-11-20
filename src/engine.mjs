// 送达事实引擎：从受理门户、承运方、电子服务站三类记录推导
// 每个主体、每份文书版本的送达状态、补送授权与期限冲突。
//
// 原则：
// - posted 只证明交寄，不证明到达；
// - 门房签收须与同一主体的清单回读合成一次送达，本人逐件确认可独立成立；
// - 送达事件按登记联系信息上的当地时区取本地日期，代理资格按该日期核验；
//   晚录入的旧地址回执按其实际发生日认定，不当成新送达事实；
// - 同一文书版本对同一主体只存在一份正在生效的办复义务，
//   由已证实有效的最早一次送达决定首次期限；
// - 已通知的答复窗口不被系统自动缩短，冲突一律交人工裁决；
// - 补送单只增不删：未寄出的可停止，已交承运的显示待撤或无从撤回。

import { addWorkdays, compareDates, localDateOf } from './calendar.mjs';

export const ORDER_STATE = Object.freeze({
  PENDING: '待发',
  POSTED: '已交承运',
  STOPPED: '已停止',
  RECALLING: '待撤',
  RECALLED: '已撤回',
  UNRECALLABLE: '无从撤回',
});

const OPEN_ORDER_STATES = new Set([ORDER_STATE.PENDING, ORDER_STATE.POSTED, ORDER_STATE.RECALLING]);

export const docKeyOf = (caseId, notice, edition) => `${caseId}/${notice}#${edition}`;

export class ServiceProofEngine {
  constructor({ today, workdayCount = 5 } = {}) {
    if (!today) throw new Error('需要指定工作台参考日 today');
    this.today = today; // 工作台参考日（YYYY-MM-DD），用于挑选当前有效地址
    this.workdayCount = workdayCount; // 送达日后办复工作日数
    this.seen = new Set(); // 来源记录键去重（来源记录键与业务身份分别定义）
    this.records = []; // 全部已收记录，按到达次序
    this.arrival = 0;
    this.orders = []; // 补送单，只增不删
    this.nextOrderId = 1;
  }

  ingest(source, entry, stage) {
    const key = `${source}:${entry.record}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.arrival += 1;
    this.records.push({
      source,
      stage,
      seq: this.arrival,
      kind: entry.kind,
      record: entry.record,
      payload: entry.payload,
    });
    return true;
  }

  ingestAll(source, entries, stage) {
    let added = 0;
    for (const entry of entries) if (this.ingest(source, entry, stage)) added += 1;
    return added;
  }

  // ---- 补送单：工作台动作 ----

  issueReservice({ party, docKey, point, agent, reason }) {
    const order = {
      id: `R${this.nextOrderId}`,
      party,
      docKey,
      point,
      agent,
      issuedOn: this.today,
      issuedSeq: this.arrival,
      state: ORDER_STATE.PENDING,
      bag: null,
      history: [{ state: ORDER_STATE.PENDING, note: reason ?? '工作台发出补送' }],
    };
    this.nextOrderId += 1;
    this.orders.push(order);
    return order;
  }

  // 送达席动作：为尚无有效送达、且没有未结补送单的项目按当前有效地址补送。
  // 已生效的项目不在此列，不会被再自动补送。
  issueEligibleReservice() {
    const view = this.derive();
    const issued = [];
    for (const item of view.items) {
      if (item.obligation) continue;
      const hasOpen = this.orders.some(
        (order) => order.party === item.party && order.docKey === item.docKey && OPEN_ORDER_STATES.has(order.state),
      );
      if (hasOpen) continue;
      const address = this.currentAddress(item.party, view.addresses);
      if (!address) continue;
      issued.push(this.issueReservice({
        party: item.party,
        docKey: item.docKey,
        point: address.point,
        agent: address.agent,
        reason: '无有效送达，按当前有效地址补送',
      }));
    }
    return issued;
  }

  // 当前有效地址：参考日在有效时段内；多处有效时取有效截止最晚者（承办人改用的新地址）。
  currentAddress(party, addresses) {
    const valid = addresses.filter(
      (a) => a.party === party && a.valid[0] <= this.today && this.today <= a.valid[1],
    );
    valid.sort((a, b) => b.valid[1].localeCompare(a.valid[1]) || b.valid[0].localeCompare(a.valid[0]));
    return valid[0] ?? null;
  }

  // 补送单状态核对：在每次收记录或发单之后调用。
  reconcile() {
    const view = this.derive();
    // 1) 承运交寄记录认领补送单：只认领补送单发出之后到达的交寄，更早的交寄与补送单无关。
    for (const rec of this.records) {
      if (rec.kind !== 'posted') continue;
      for (const row of rec.payload.docs ?? []) {
        const [caseId, notice, edition, party] = row;
        const docKey = docKeyOf(caseId, notice, edition);
        const order = this.orders.find(
          (o) => o.state === ORDER_STATE.PENDING
            && o.party === party
            && o.docKey === docKey
            && o.point === rec.payload.point
            && o.issuedSeq < rec.seq,
        );
        if (order) {
          order.state = ORDER_STATE.POSTED;
          order.bag = rec.payload.bag;
          order.history.push({ state: ORDER_STATE.POSTED, note: `承运方确认交寄，袋号 ${rec.payload.bag}`, record: rec.record });
        }
      }
    }
    // 2) 送达已被证实的项目：未寄出的补送停止，已交承运的转待撤（记录保留，不抹去）。
    const byItem = new Map(view.items.map((item) => [`${item.docKey}::${item.party}`, item]));
    for (const order of this.orders) {
      const item = byItem.get(`${order.docKey}::${order.party}`);
      if (!item?.obligation) continue;
      if (order.state === ORDER_STATE.PENDING) {
        order.state = ORDER_STATE.STOPPED;
        order.history.push({ state: ORDER_STATE.STOPPED, note: `送达已于 ${item.obligation.since} 证实，停止未寄出的补送` });
      } else if (order.state === ORDER_STATE.POSTED) {
        order.state = ORDER_STATE.RECALLING;
        order.history.push({ state: ORDER_STATE.RECALLING, note: `送达已于 ${item.obligation.since} 经其他途径证实，申请撤回在途补送` });
      }
    }
    // 3) 待撤中的补送若袋件已被签收，则无从撤回。
    const signedBags = new Set(this.records.filter((r) => r.kind === 'signed').map((r) => r.payload.bag));
    for (const order of this.orders) {
      if (order.state === ORDER_STATE.RECALLING && order.bag && signedBags.has(order.bag)) {
        order.state = ORDER_STATE.UNRECALLABLE;
        order.history.push({ state: ORDER_STATE.UNRECALLABLE, note: `袋号 ${order.bag} 已有签收记录，无从撤回` });
      }
    }
    return view;
  }

  // ---- 全量推导：每次调用都从原始记录重算，保证与到达次序一致 ----

  derive() {
    const rules = new Map();
    const docs = new Map();
    const addresses = [];
    const bags = new Map();
    const confirmations = [];
    const openings = [];
    const deadlineRecords = [];
    const foreign = [];

    const bagOf = (id) => {
      if (!bags.has(id)) bags.set(id, { posted: [], signed: [], manifests: [] });
      return bags.get(id);
    };

    for (const rec of this.records) {
      const p = rec.payload;
      switch (rec.kind) {
        case 'rule':
          rules.set(p.region, {
            region: p.region,
            workDays: p.workDays,
            holiday: p.holiday ?? [],
            mode: p.mode ?? null,
            combine: p.combine ?? null,
            record: rec.record,
          });
          break;
        case 'notice': {
          const docKey = docKeyOf(p.case, p.notice, p.edition);
          docs.set(docKey, {
            docKey,
            case: p.case,
            notice: p.notice,
            edition: p.edition,
            region: p.region,
            parties: [...p.parties],
            record: rec.record,
          });
          break;
        }
        case 'address':
          addresses.push({ party: p.party, agent: p.agent, point: p.point, zone: p.zone, valid: [...p.valid], record: rec.record });
          break;
        case 'posted':
          bagOf(p.bag).posted.push({ bag: p.bag, docs: p.docs ?? [], point: p.point, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        case 'signed':
          bagOf(p.bag).signed.push({ bag: p.bag, agent: p.agent, point: p.point, occurred: p.occurred, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        case 'manifest':
          bagOf(p.bag).manifests.push({ bag: p.bag, party: p.party, notice: p.notice, edition: p.edition, agent: p.agent ?? null, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        case 'confirmed':
          confirmations.push({ case: p.case, notice: p.notice, edition: p.edition, party: p.party, agent: p.agent, scope: p.scope, time: p.time, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        case 'opened':
          openings.push({ case: p.case, notice: p.notice, edition: p.edition, party: p.party, scope: p.scope, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        case 'deadline':
          deadlineRecords.push({ party: p.party, notice: p.notice, edition: p.edition, issued: p.issued, due: p.due, record: rec.record, seq: rec.seq, stage: rec.stage });
          break;
        default:
          foreign.push({ record: rec.record, kind: rec.kind, reason: `未识别的记录类型 ${rec.kind}` });
      }
    }

    // 代理资格核验：按登记联系信息的当地时区取事件本地日期，须落在有效时段内。
    const qualify = (party, agent, point, occurred) => {
      const entries = addresses.filter(
        (a) => a.party === party && a.agent === agent && (!point || a.point === point),
      );
      if (entries.length === 0) {
        return { error: `主体 ${party} 没有代理 ${agent}${point ? ` 在 ${point}` : ''} 的登记联系信息` };
      }
      const dated = entries.map((entry) => ({ entry, localDate: localDateOf(occurred, entry.zone) }));
      const valid = dated.filter((x) => x.entry.valid[0] <= x.localDate && x.localDate <= x.entry.valid[1]);
      if (valid.length === 0) {
        return { error: `代理 ${agent} 的资格在事件当地日期不处于有效时段` };
      }
      valid.sort((a, b) => b.entry.valid[1].localeCompare(a.entry.valid[1]));
      return valid[0];
    };

    const candidates = [];

    // 本人逐件确认：独立成立。
    for (const c of confirmations) {
      const docKey = docKeyOf(c.case, c.notice, c.edition);
      const base = {
        party: c.party, docKey, agent: c.agent, kind: '本人逐件确认',
        occurred: c.time, record: c.record, knownSeq: c.seq, knownStage: c.stage,
      };
      if (!docs.has(docKey)) {
        foreign.push({ record: c.record, kind: c.kind ?? 'confirmed', reason: '确认回执对应不到受理文书' });
        continue;
      }
      const q = qualify(c.party, c.agent, null, c.time);
      if (q.error) candidates.push({ ...base, valid: false, reason: q.error });
      else candidates.push({ ...base, valid: true, point: q.entry.point, zone: q.entry.zone, localDate: q.localDate });
    }

    // 门房签收 + 同一主体清单回读：合成一次送达。一袋可装多封文书，逐件判定。
    for (const [bagId, bag] of bags) {
      for (const s of bag.signed) {
        const postedRows = bag.posted.flatMap((po) => (po.docs ?? []).map((row) => row));
        if (postedRows.length === 0) {
          foreign.push({ record: s.record, kind: 'signed', reason: `袋号 ${bagId} 的签收对应不到交寄记录` });
          continue;
        }
        for (const row of postedRows) {
          const [caseId, notice, edition, party] = row;
          const docKey = docKeyOf(caseId, notice, edition);
          const base = {
            party, docKey, agent: s.agent, kind: '门房签收+清单回读',
            occurred: s.occurred, point: s.point, bag: bagId,
            record: s.record, knownSeq: s.seq, knownStage: s.stage,
          };
          const manifest = bag.manifests.find(
            (m) => m.party === party && m.notice === notice && m.edition === edition,
          );
          if (!manifest) {
            candidates.push({ ...base, valid: false, reason: '门房签收缺少同一主体的清单回读，不能合成送达' });
            continue;
          }
          if (manifest.agent && manifest.agent !== s.agent) {
            candidates.push({ ...base, valid: false, reason: '清单回读的代理与签收代理不一致' });
            continue;
          }
          // 合成事实在签收与清单两者都到达后才可知。
          const knownSeq = Math.max(s.seq, manifest.seq);
          const knownStage = Math.max(s.stage, manifest.stage);
          const q = qualify(party, s.agent, s.point, s.occurred);
          if (q.error) {
            candidates.push({ ...base, valid: false, reason: q.error, knownSeq, knownStage });
          } else {
            candidates.push({
              ...base, valid: true, zone: q.entry.zone, localDate: q.localDate,
              knownSeq, knownStage, manifestRecord: manifest.record,
            });
          }
        }
      }
    }

    // 仅开启通知封面：不足以作为文书确认。
    for (const o of openings) {
      const docKey = docKeyOf(o.case, o.notice, o.edition);
      candidates.push({
        party: o.party, docKey, kind: '开启通知', valid: false,
        reason: `回读范围为${o.scope}，不足以确认文书`,
        record: o.record, knownSeq: o.seq, knownStage: o.stage,
      });
    }

    // 每个主体、每份文书版本：有效送达事件、被退回的凭据、唯一生效义务。
    const conflicts = [];
    const conflictKeys = new Set();
    const addConflict = (entry) => {
      const key = `${entry.type}:${entry.record ?? ''}:${entry.party ?? ''}:${entry.docKey ?? ''}:${entry.localDate ?? ''}`;
      if (conflictKeys.has(key)) return;
      conflictKeys.add(key);
      conflicts.push(entry);
    };

    const items = [];
    for (const doc of docs.values()) {
      const rule = rules.get(doc.region) ?? null;
      if (!rule) {
        addConflict({ type: '缺少服务地区规则', record: doc.record, docKey: doc.docKey, note: `案件指定服务地区 ${doc.region} 没有送达规则` });
      }
      for (const party of doc.parties) {
        const mine = candidates.filter((c) => c.docKey === doc.docKey && c.party === party);
        const events = mine
          .filter((c) => c.valid)
          .sort((a, b) => compareDates(a.localDate, b.localDate) || a.knownSeq - b.knownSeq);
        const rejected = mine.filter((c) => !c.valid);
        let obligation = null;
        if (events.length > 0 && rule) {
          const first = events[0];
          obligation = {
            since: first.localDate,
            due: addWorkdays(first.localDate, this.workdayCount, rule),
            basis: first,
            workdayCount: this.workdayCount,
          };
        }
        items.push({
          docKey: doc.docKey, case: doc.case, notice: doc.notice, edition: doc.edition,
          region: doc.region, party, rule, events, rejected, obligation,
        });
      }
    }

    // 期限通知追踪：定位是哪份文书、哪次服务、在何地起算。
    const deadlineTraces = [];
    for (const d of deadlineRecords) {
      const matches = items.filter((i) => i.notice === d.notice && i.edition === d.edition && i.party === d.party);
      if (matches.length !== 1) {
        addConflict({ type: '期限通知无法唯一对应', record: d.record, party: d.party, note: `通知 ${d.notice}#${d.edition} 无法唯一对应受理文书` });
        continue;
      }
      const item = matches[0];
      const rule = item.rule;
      const dueOf = (event) => (rule ? addWorkdays(event.localDate, this.workdayCount, rule) : null);
      // 起算依据：通知登记之前已可知、且不晚于发出日的有效送达中，与通知截止一致的那次。
      const knownBefore = item.events.filter((e) => e.knownSeq < d.seq && e.localDate <= d.issued);
      const basisEvent = knownBefore.find((e) => dueOf(e) === d.due) ?? knownBefore[0] ?? null;
      const first = item.obligation?.basis ?? null;
      const trace = {
        record: d.record,
        party: d.party,
        docKey: item.docKey,
        issued: d.issued,
        noticedDue: d.due,
        basis: basisEvent
          ? { localDate: basisEvent.localDate, point: basisEvent.point, kind: basisEvent.kind, agent: basisEvent.agent, due: dueOf(basisEvent) }
          : null,
        currentFirst: first
          ? { localDate: first.localDate, point: first.point, kind: first.kind, agent: first.agent }
          : null,
        pendingDue: item.obligation?.due ?? null,
        status: '一致',
      };
      if (!item.obligation) {
        trace.status = '待人工确认';
        addConflict({
          type: '期限通知缺乏送达依据', record: d.record, party: d.party, docKey: item.docKey,
          noticedDue: d.due,
          note: `期限通知截止 ${d.due}，但没有已证实有效的送达可据以起算，交人工裁决。`,
        });
      } else if (item.obligation.due !== d.due) {
        trace.status = '待人工确认';
        const earlier = first.knownSeq > d.seq;
        addConflict({
          type: '期限通知冲突', record: d.record, party: d.party, docKey: item.docKey,
          noticedDue: d.due, recomputedDue: item.obligation.due,
          earlierService: { localDate: first.localDate, point: first.point, kind: first.kind },
          note: earlier
            ? `已通知截止 ${d.due}；补证证实的更早送达 ${first.localDate}（${first.point}）起算应为 ${item.obligation.due}。只更新待决期限，不缩短已通知的答复窗口，交人工确认。`
            : `已通知截止 ${d.due} 与登记送达事实起算的 ${item.obligation.due} 不一致，交人工确认。`,
        });
      }
      deadlineTraces.push(trace);
    }

    // 迟到回执：补送发出后才登记、却证明送达发生在补送发出之日或之前。
    // 不作为新送达事实另立义务，交人工裁决。
    for (const item of items) {
      for (const e of item.events) {
        for (const order of this.orders) {
          if (order.party !== item.party || order.docKey !== item.docKey) continue;
          if (!(order.issuedSeq < e.knownSeq && e.localDate <= order.issuedOn)) continue;
          const oldAddress = e.point && e.point !== order.point;
          addConflict({
            type: oldAddress ? '迟到旧址回执' : '迟到回执',
            record: e.record,
            party: item.party,
            docKey: item.docKey,
            localDate: e.localDate,
            point: e.point,
            order: order.id,
            note: `送达发生于 ${e.localDate}（${e.point}），不晚于补送单 ${order.id} 发出日 ${order.issuedOn}，但回执在补送发出后才登记；按实际发生日认定，不另立义务，交人工裁决。`,
          });
        }
      }
    }

    for (const f of foreign) addConflict({ type: '回执无法对应', ...f });

    const undelivered = items
      .filter((i) => !i.obligation)
      .map((i) => ({
        party: i.party,
        docKey: i.docKey,
        rejected: i.rejected.map((r) => ({ kind: r.kind, reason: r.reason, record: r.record ?? null })),
      }));

    // 台账：每个主体、具体文书版本和送达事件本地日期的对应。
    const ledger = items.flatMap((i) => i.events.map((e) => ({
      party: i.party, docKey: i.docKey, localDate: e.localDate, point: e.point,
      kind: e.kind, agent: e.agent, record: e.record,
    })));
    ledger.sort((a, b) => compareDates(a.localDate, b.localDate) || a.party.localeCompare(b.party));

    return {
      today: this.today,
      workdayCount: this.workdayCount,
      docs: [...docs.values()],
      rules: [...rules.values()],
      addresses,
      items,
      conflicts,
      deadlineTraces,
      undelivered,
      ledger,
      bags: [...bags.entries()].map(([id, b]) => ({ bag: id, ...b })),
    };
  }
}

#!/usr/bin/env node
// 送达工作台命令行：按回放阶段从来源服务取得记录，逐阶段输出承办人工作台。
//
// 用法：node src/cli.mjs [--source http://127.0.0.1:4100] [--today 2026-11-20]
//                         [--through 4] [--snapshot state.json]

import { writeFile } from 'node:fs/promises';
import { ServiceProofEngine } from './engine.mjs';
import { fetchOverview, fetchSourceRecords, switchStage } from './ingest.mjs';
import { buildWorkbench, renderWorkbench } from './workbench.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const source = option('source', 'http://127.0.0.1:4100');
const today = option('today', new Date().toISOString().slice(0, 10));
const through = Number(option('through', '0'));
const snapshot = option('snapshot', null);

const overview = await fetchOverview(source);
const lastStage = through > 0 ? Math.min(through, overview.stages) : overview.stages;
const engine = new ServiceProofEngine({ today });

for (let stage = 1; stage <= lastStage; stage += 1) {
  await switchStage(source, stage);
  for (const name of overview.sources) {
    engine.ingestAll(name, await fetchSourceRecords(source, name), stage);
  }
  engine.reconcile();
  const issued = engine.issueEligibleReservice();
  const workbench = buildWorkbench(engine);
  console.log(renderWorkbench(workbench, { stage, issued }));
  console.log('');
}

if (snapshot) {
  const derived = engine.derive();
  await writeFile(snapshot, `${JSON.stringify({ today, orders: engine.orders, derived }, null, 2)}\n`);
  console.log(`推导结果已写入 ${snapshot}`);
}

// 从来源服务分页拉取记录。只使用 Node.js 自带的 fetch。

export async function fetchOverview(baseUrl) {
  const response = await fetch(`${baseUrl}/`);
  if (!response.ok) throw new Error(`来源概览读取失败: ${response.status}`);
  return response.json();
}

export async function switchStage(baseUrl, stage) {
  const response = await fetch(`${baseUrl}/control?stage=${stage}`, { method: 'POST' });
  if (!response.ok) throw new Error(`切换回放阶段失败: ${response.status}`);
  return (await response.json()).stage;
}

// 跟随响应中的 next 偏移取回一个来源的全部可见记录。
export async function fetchSourceRecords(baseUrl, name) {
  const records = [];
  let offset = 0;
  while (offset !== null) {
    const response = await fetch(`${baseUrl}/source/${name}?offset=${offset}&limit=100`);
    if (!response.ok) throw new Error(`来源 ${name} 读取失败: ${response.status}`);
    const page = await response.json();
    records.push(...page.records);
    offset = page.next;
  }
  return records;
}

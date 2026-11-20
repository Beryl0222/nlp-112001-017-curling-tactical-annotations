import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { buildFactModel, deriveThrower, splitIntoClauses } from '../src/model.js';
import { buildLesson, previewText, renderClause } from '../src/lesson.js';
import { buildComparison } from '../src/compare.js';
import { printEntryText, queryPrints, recordPrint } from '../src/print-log.js';

async function loadFixture(overrides = {}) {
  const tables = await readMaterials();
  for (const [name, rows] of Object.entries(overrides)) {
    tables[name] = rows;
  }
  return { tables, model: buildFactModel(tables) };
}

test('分句保留原文与字符区间，标点不拆分字段', () => {
  const sentences = splitIntoClauses('白方护着他们自己的中心壶。该投结果还没定。');
  assert.equal(sentences.length, 2);
  const joined = sentences.flatMap(s => s.clauses.map(c => c.text)).join('');
  assert.equal(joined, '白方护着他们自己的中心壶。该投结果还没定。');
  const first = sentences[0].clauses[0];
  assert.equal(first.start, 0);
  assert.equal(first.end, '白方护着他们自己的中心壶。'.length);
});

test('颜色、队名、我方/对手与中立视角的实体解析', async () => {
  const { model } = await loadFixture();
  const n1 = model.records.find(r => r.id === 'n1');
  const n2 = model.records.find(r => r.id === 'n2');
  const n4 = model.records.find(r => r.id === 'n4');

  const self = n1.clauses[0].mentions.find(m => m.raw === '我方');
  assert.equal(self.resolved.side, 'A');
  assert.equal(self.resolved.name, '岩溪');

  const rival = n2.clauses[0].mentions.find(m => m.raw === '对手');
  assert.equal(rival.resolved.side, 'A');
  assert.equal(rival.note, '观察者对方');

  const us = n2.clauses[0].mentions.find(m => m.raw === '我们');
  assert.equal(us.resolved.side, 'B');

  const coachRival = n4.clauses[0].mentions.find(m => m.raw === '对手');
  assert.equal(coachRival.status, '待确认');
  assert.ok(model.ambiguities.some(a => a.recordId === 'n4' && a.raw === '对手'));
});

test('保护壶与中心壶的归属按同句证据解析', async () => {
  const { model } = await loadFixture();
  const n1Stone = model.records.find(r => r.id === 'n1').clauses[1].mentions.find(m => m.kind === 'stone');
  assert.equal(n1Stone.resolved.role, '中心壶');
  assert.equal(n1Stone.resolved.owner.side, 'B');
  assert.equal(n1Stone.resolved.ownerBasis, '同句队伍指称');

  const n2Stone = model.records.find(r => r.id === 'n2').clauses[0].mentions.find(m => m.kind === 'stone');
  assert.equal(n2Stone.resolved.role, '保护壶');
  assert.equal(n2Stone.resolved.owner.colour, '白');
  assert.equal(n2Stone.resolved.ownerBasis, '同句颜色词');
});

test('裁判更正改判第一回合后手，第二回合数值保留但标注抄串', async () => {
  const { model } = await loadFixture();
  const [end1, end2] = model.ends;
  assert.equal(end1.hammer.sheetValue, '蓝');
  assert.equal(end1.hammer.effectiveColour, '白');
  assert.equal(end1.hammer.status, '已更正');
  assert.equal(end1.hammer.correction.recordId, 'n5');
  assert.deepEqual(end1.hammer.correction.range, [0, 10]);

  assert.equal(end2.hammer.effectiveColour, '白');
  assert.match(end2.hammer.status, /抄串/);
  assert.ok(model.corrections.some(c => c.targetEnd === 1 && c.copyErrorFromEnd === 2));
});

test('投壶方由后手与交替顺序推导，不从比分倒推', async () => {
  const { model } = await loadFixture();
  const end1 = model.ends[0];
  assert.equal(deriveThrower(end1, 3).side, 'A');
  assert.equal(deriveThrower(end1, 4).side, 'B');
  assert.match(deriveThrower(end1, 3).basis, /非由比分推断/);
  const end2 = model.ends[1];
  assert.equal(deriveThrower(end2, 3).side, 'A');
});

test('跨视角左右翻转后方向一致，中立视角的左右保留原值待确认', async () => {
  const { model } = await loadFixture();
  const group = model.eventGroups.find(g => g.end === 1 && g.shot === 3);
  assert.equal(group.directionConsistent, true);
  const canonical = group.basis.map(b => b.canonicalSide);
  assert.deepEqual(canonical, ['左', '左']);

  const n4Dir = model.records.find(r => r.id === 'n4').clauses[1].mentions.find(m => m.kind === 'direction');
  assert.equal(n4Dir.status, '待确认');
  assert.equal(n4Dir.resolved.view, null);
});

test('子句区分局势、行动、假想、结果、待定与更正', async () => {
  const { model } = await loadFixture();
  const byId = id => model.records.find(r => r.id === id);
  const types = Object.fromEntries(
    byId('n3').clauses.map(c => [c.id, c.type])
  );
  assert.deepEqual(Object.values(types), ['假想', '假想', '结果']);
  assert.equal(byId('n2').clauses[1].type, '待定');
  assert.deepEqual(byId('n5').clauses.map(c => c.type), ['更正', '更正']);
  assert.equal(byId('n1').clauses[0].type, '行动');
  assert.equal(byId('n1').clauses[1].type, '局势');
});

test('假想前提与后手更正冲突时标注失效，不臆造未叙述动作', async () => {
  const { model } = await loadFixture();
  const premise = model.records.find(r => r.id === 'n3').clauses[0].premiseConflict;
  assert.ok(premise);
  assert.match(premise.note, /前提失效/);
  assert.match(premise.conflictWith, /n5/);
  // 模型只包含资料中出现过的记录编号，没有合成新行动。
  assert.deepEqual([...new Set(model.records.map(r => r.id))].sort(), ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('教学计划视角解析，更正回合全部带重核标记且方位保留原值', async () => {
  const { model } = await loadFixture();
  const p1 = model.plans.find(p => p.id === 'p1');
  assert.equal(p1.viewSide, 'A');
  assert.equal(p1.recheckRequired, true);
  assert.ok(p1.recheckReasons.some(r => r.includes('后手已由')));
  assert.ok(p1.recheckReasons.some(r => r.includes('保留原方位')));
  const p3 = model.plans.find(p => p.id === 'p3');
  assert.equal(p3.viewSide, 'B');
  assert.equal(p3.recheckRequired, false);
});

test('p1 学员包只保留起始投之前局势，行动、结果、假想、更正均隐藏', async () => {
  const { model } = await loadFixture();
  const packet = buildLesson(model, 'p1');
  const visible = packet.student.visibleClauses;
  assert.deepEqual(visible.map(c => c.recordId), ['n1']);
  assert.equal(visible[0].type, '局势');
  assert.equal(packet.student.openness.open, true);

  const hiddenReasons = packet.student.hiddenAudit.map(h => h.reason);
  assert.ok(hiddenReasons.some(r => r.includes('开放题答案')));
  assert.ok(hiddenReasons.some(r => r.includes('假想')));
  assert.ok(hiddenReasons.some(r => r.includes('后来结果')));
  assert.ok(hiddenReasons.some(r => r.includes('裁判更正')));

  // 学员文本不含原文代词与实际投法。
  const studentText = visible.map(c => c.renderedText).join('\n');
  assert.ok(!studentText.includes('我方'));
  assert.ok(!studentText.includes('绕过'));
  assert.ok(!studentText.includes('得一分'));
});

test('视角渲染：代词显式化、左右随目标视角翻转', () => {
  const endModel = {
    teams: {
      A: { side: 'A', colour: '蓝', name: '岩溪', aliases: ['蓝', '岩溪'] },
      B: { side: 'B', colour: '白', name: '柳甸', aliases: ['白', '柳甸'] }
    }
  };
  const clause = {
    text: '对手朝我们右手边绕过白色保护壶，',
    start: 100,
    mentions: [
      { kind: 'team', raw: '对手', range: [100, 102], resolved: endModel.teams.A, status: '已确认', note: '观察者对方' },
      { kind: 'team', raw: '我们', range: [103, 105], resolved: endModel.teams.B, status: '已确认', note: '观察者本方' },
      { kind: 'direction', raw: '右手边', range: [105, 108], resolved: { side: '右', view: 'B' }, status: '已确认' },
      { kind: 'stone', raw: '白色保护壶', range: [110, 115], resolved: { role: '保护壶', owner: endModel.teams.B }, status: '已确认' }
    ]
  };
  const record = { id: 'n2' };
  const toA = renderClause(clause, record, endModel, 'A');
  assert.equal(toA.renderedText, '蓝（岩溪）朝白（柳甸）左手边绕过白色保护壶，');
  const toB = renderClause(clause, record, endModel, 'B');
  assert.equal(toB.renderedText, '蓝（岩溪）朝白（柳甸）右手边绕过白色保护壶，');
});

test('p3 第二回合缺少有依据局势时拒绝直接付印并列出待确认', async () => {
  const { model } = await loadFixture();
  const packet = buildLesson(model, 'p3');
  assert.equal(packet.student.visibleClauses.length, 0);
  assert.match(packet.student.question.text, /不得直接付印/);
  assert.ok(packet.student.ambiguities.length >= 2);
  assert.ok(packet.student.hiddenAudit.some(h => h.reason.includes('不能串场')));
  assert.ok(packet.student.hiddenAudit.some(h => h.reason.includes('假想')));
});

test('调整起始投后上下文、来源区间与可见范围联动', async () => {
  const { model } = await loadFixture();
  const packet = buildLesson(model, 'p1', { startOverride: 4 });
  assert.equal(packet.startAdjusted, true);
  assert.equal(packet.startShot, 4);
  const visibleIds = [...new Set(packet.student.visibleClauses.map(c => c.recordId))];
  assert.deepEqual(visibleIds.sort(), ['n1', 'n2']);
  // 第 3 投行动此时属于历史局势，可以出现；第 4 投的假想与结果仍隐藏。
  assert.ok(packet.student.hiddenAudit.every(h => h.shot >= 4));
  assert.ok(packet.basis.some(b => b.id === 'p1' && b.note.includes('起始投 4')));
});

test('对照保持两个独立面板并阻断串场；无局势支撑时判定不可合并并给出处理结论', async () => {
  const { model } = await loadFixture();
  const comparison = buildComparison(model, ['p1', 'p3']);
  // p3 的唯一记录是中立视角的行动与跨回合假想，无学员可用局势，同页不可合并。
  assert.equal(comparison.mergeable, false);
  assert.equal(comparison.panels.length, 2);
  assert.notEqual(comparison.panels[0].end, comparison.panels[1].end);
  assert.equal(comparison.panels.find(p => p.planId === 'p3').hasUsableSituation, false);
  assert.match(comparison.verdict, /不能合并|改写/);
  // 串场内容始终被拦截在学员视图之外。
  assert.equal(comparison.crossLeaks.length, 0);

  // 构造第二回合只有跨回合假想、没有任何本回合局势的资料：
  // 系统正确隐藏串场内容后，该面板无局势可支撑开放题，审计应判定不可合并。
  const tampered = buildFactModel({
    '赛表.json': [
      { id: 'e1', match: '东湾练习赛', end: '1', colourA: '蓝 岩溪', colourB: '白 柳甸', hammer: '蓝', direction: '北向' },
      { id: 'e2', match: '东湾练习赛', end: '2', colourA: '蓝 岩溪', colourB: '白 柳甸', hammer: '白', direction: '南向' }
    ],
    '逐投记录.json': [
      { id: 'x1', end: '2', shot: '3', observer: '柳甸', text: '假如像前回合左侧有保护壶，才考虑走外线。' },
      { id: 'x2', end: '1', shot: '3', observer: '岩溪', text: '我方蓝壶绕过白壶。' }
    ],
    '教学计划.json': [
      { id: 'q1', reader: '学员', start: '3', end: '2', angle: '柳甸视角' },
      { id: 'q2', reader: '学员', start: '3', end: '1', angle: '岩溪视角' }
    ]
  });
  const bad = buildComparison(tampered, ['q1', 'q2']);
  // 串场内容必须被拦截，不得进入学员视图。
  assert.equal(bad.crossLeaks.length, 0);
  assert.ok(bad.packets[0].student.hiddenAudit.some(h => h.reason.includes('不能串场')));
  // 但第二面板因此没有任何可用局势，同页无法维持开放性。
  assert.equal(bad.mergeable, false);
  assert.match(bad.verdict, /不能合并|改写/);
});

test('两个面板都有本回合局势时允许独立面板对照，且不串场', async () => {
  const good = buildFactModel({
    '赛表.json': [
      { id: 'e1', match: '东湾练习赛', end: '1', colourA: '蓝 岩溪', colourB: '白 柳甸', hammer: '蓝', direction: '北向' },
      { id: 'e2', match: '东湾练习赛', end: '2', colourA: '蓝 岩溪', colourB: '白 柳甸', hammer: '白', direction: '南向' }
    ],
    '逐投记录.json': [
      { id: 'x1', end: '1', shot: '3', observer: '岩溪', text: '白方护着中心壶。' },
      { id: 'x2', end: '2', shot: '3', observer: '柳甸', text: '蓝方在门前留有保护壶。' }
    ],
    '教学计划.json': [
      { id: 'q1', reader: '学员', start: '3', end: '1', angle: '岩溪视角' },
      { id: 'q2', reader: '学员', start: '3', end: '2', angle: '柳甸视角' }
    ]
  });
  const cmp = buildComparison(good, ['q1', 'q2']);
  assert.equal(cmp.mergeable, true);
  assert.equal(cmp.crossLeaks.length, 0);
  assert.ok(cmp.panels.every(p => p.hasUsableSituation));
  assert.match(cmp.verdict, /独立面板/);
});

test('非同一赛事或同一回合的对照请求被拒绝', async () => {
  const { tables } = await loadFixture();
  const other = structuredClone(tables);
  other['赛表.json'][1] = { ...other['赛表.json'][1], match: '西港邀请赛' };
  const model = buildFactModel(other);
  assert.throws(() => buildComparison(model, ['p1', 'p3']), /同一赛事/);
  assert.throws(() => buildComparison(model, ['p1', 'p1']), /两个不同/);
});

test('印刷日志按班次记录视角与依据，可按班次/班级/计划查询', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'print-log-'));
  const file = join(dir, 'log.ndjson');
  try {
    const { model } = await loadFixture();
    const packet = buildLesson(model, 'p1');
    const record = await recordPrint(
      packet,
      { batchId: '班次03', classId: '甲班', operator: '训练员甲' },
      { file }
    );
    assert.equal(record.view.team.name, '岩溪');
    assert.equal(record.hammer.effectiveColour, '白');
    assert.equal(record.recheckRequired, true);
    assert.ok(record.contentHash.length === 64);
    assert.ok(record.basis.some(b => b.id === 'n5' && b.range[0] === 0));

    await recordPrint(buildLesson(model, 'p3'), { batchId: '班次03', classId: '乙班' }, { file });
    const all = await queryPrints({}, { file });
    assert.equal(all.length, 2);
    const batch = await queryPrints({ batchId: '班次03' }, { file });
    assert.equal(batch.length, 2);
    const classOnly = await queryPrints({ classId: '甲班' }, { file });
    assert.deepEqual(classOnly.map(r => r.planId), ['p1']);
    const planOnly = await queryPrints({ planId: 'p3' }, { file });
    assert.deepEqual(planOnly.map(r => r.classId), ['乙班']);
    assert.match(printEntryText(record), /当时视角/);

    const raw = await readFile(file, 'utf8');
    assert.ok(raw.trim().split('\n').every(line => JSON.parse(line)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('损坏的印刷日志给出文件名与行号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'print-log-'));
  const file = join(dir, 'broken.ndjson');
  try {
    await writeFile(file, '{not json}\n', 'utf8');
    await assert.rejects(queryPrints({}, { file }), /第 1 行/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('预览同时包含学员与教员两个视图', async () => {
  const { model } = await loadFixture();
  const text = previewText(buildLesson(model, 'p1'));
  assert.match(text, /学员视图/);
  assert.match(text, /教员视图/);
  assert.match(text, /答案：起始投的已发生行动/);
  assert.match(text, /依据区间/);
});

test('未知教学计划与越界起点给出明确错误', async () => {
  const { model } = await loadFixture();
  assert.throws(() => buildLesson(model, 'nope'), /教学计划 nope 不存在/);
  assert.throws(() => buildLesson(model, 'p1', { startOverride: 0 }), /起始投必须是正整数/);
});

test('资料缺字段时 readMaterials 仍按原约定报错（回归）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'materials-bad-'));
  try {
    const { mkdir, cp } = await import('node:fs/promises');
    await mkdir(join(dir, '资料'));
    await cp(new URL('../资料/', import.meta.url), join(dir, '资料'), { recursive: true });
    await writeFile(join(dir, '资料', '赛表.json'), '[{}]', 'utf8');
    await assert.rejects(readMaterials(pathToFileURL(join(dir, '资料') + '/')), /赛表\.json.*第 1 条/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

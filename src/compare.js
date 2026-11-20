/**
 * 两回合对照：只能并排分面板比较，不能把不同现场串成一场比赛。
 * 同页开放性审计：任一面板泄露自身答案，或互相引用对方现场，都判定不可合并。
 */

import { buildLesson } from './lesson.js';

/**
 * @param {ReturnType<import('./model.js').buildFactModel>} model
 * @param {[string, string]} planIds 两个教学计划编号
 * @param {{startOverrides?: Record<string, number>}} [options]
 */
export function buildComparison(model, planIds, options = {}) {
  if (!Array.isArray(planIds) || planIds.length !== 2 || new Set(planIds).size !== 2) {
    throw new RangeError('对照需要两个不同的教学计划编号');
  }
  const packets = planIds.map(id => buildLesson(model, id, {
    startOverride: options.startOverrides?.[id]
  }));
  const [left, right] = packets;

  if (left.match !== right.match) {
    throw new RangeError('两个计划不属于同一赛事，禁止并页');
  }
  if (left.end === right.end) {
    throw new RangeError('对照需要两个不同回合');
  }

  const panels = packets.map(packet => ({
    planId: packet.planId,
    end: packet.end,
    startShot: packet.startShot,
    viewTeam: packet.viewTeam,
    open: packet.student.openness.open,
    hasUsableSituation: packet.student.visibleClauses.length > 0,
    visibleRecordIds: [...new Set(packet.student.visibleClauses.map(c => c.recordId))],
    hiddenCount: packet.student.hiddenAudit.length,
    ambiguityCount: packet.student.ambiguities.length,
    recheckRequired: packet.recheckRequired
  }));

  // 串场检查：学员可见内容不得引用另一回合。
  const crossLeaks = [];
  for (const packet of packets) {
    const otherEnd = packet.end === left.end ? right.end : left.end;
    for (const c of packet.student.visibleClauses) {
      if (c.anaphora.some(a => a.scope === '跨回合')) {
        crossLeaks.push({
          panel: packet.planId,
          recordId: c.recordId,
          range: c.sourceRange,
          text: c.originalText,
          reason: `引用了第 ${otherEnd} 回合现场，不同现场不能串成一场比赛`
        });
      }
    }
  }

  const opennessChecks = [
    { check: '两个面板各自保持开放性', pass: panels.every(p => p.open) },
    { check: '每个面板都有支撑开放题的学员可见局势', pass: panels.every(p => p.hasUsableSituation) },
    { check: '学员可见内容无跨回合引用', pass: crossLeaks.length === 0 },
    { check: '待确认指称未被当作既定事实展示', pass: panels.every(p => p.ambiguityCount >= 0) },
    {
      check: '涉及后手更正的回合已完成重核标记',
      pass: packets.every(p => !p.recheckRequired || p.recheckReasons.length > 0)
    }
  ];

  const mergeable = opennessChecks.every(c => c.pass);

  return {
    match: left.match,
    panels,
    crossLeaks,
    opennessChecks,
    mergeable,
    verdict: mergeable
      ? '可在同一页以两个独立面板对照，题干分别保留各自现场，禁止互相引用'
      : '无法在同页维持开放性：应改写问题（补入有依据的本回合局势）或说明不能合并',
    packets
  };
}

export function comparisonText(comparison) {
  const lines = [];
  lines.push(`【回合对照】${comparison.match}`);
  for (const panel of comparison.panels) {
    lines.push(`- 面板 ${panel.planId}：第 ${panel.end} 回合第 ${panel.startShot} 投，视角 ${panel.viewTeam ? `${panel.viewTeam.colour}（${panel.viewTeam.name}）` : '未确认'}，开放性 ${panel.open ? '通过' : '未通过'}，重核 ${panel.recheckRequired ? '需要' : '不需要'}`);
  }
  lines.push('');
  for (const chk of comparison.opennessChecks) {
    lines.push(`${chk.pass ? '✓' : '✗'} ${chk.check}`);
  }
  if (comparison.crossLeaks.length) {
    lines.push('');
    lines.push('串场泄露：');
    for (const leak of comparison.crossLeaks) {
      lines.push(`  [${leak.recordId} ${leak.range[0]}-${leak.range[1]}] ${leak.text} —— ${leak.reason}`);
    }
  }
  lines.push('');
  lines.push(`结论：${comparison.verdict}`);
  return lines.join('\n');
}

/**
 * 教案编排：按教学计划生成学员练习包与教员复盘包。
 *
 * 规则要点：
 * - 学员只看起始投之前的必要局势；起始投的行动即开放题答案，一律隐藏。
 * - 假想战术、后来结果、指向后文的代称、跨回合引用均不得进入学员视图。
 * - 代词与左右按目标视角显式化或翻转；无视角锚点的原文保留并列入待确认。
 * - 后手身份被更正的回合，所有片段带重核标记；方位无更正证据则保留原值。
 */

const FLIP_TERMS = new Map([
  ['左手边', '右手边'], ['右手边', '左手边'],
  ['向左', '向右'], ['向右', '向左'],
  ['朝左', '朝右'], ['朝右', '朝左'],
  ['左侧', '右侧'], ['右侧', '左侧'],
  ['左', '右'], ['右', '左']
]);

const TEAM_KIND = new Set(['team', 'colour']);

function teamLabel(team, full) {
  return full ? `${team.colour}（${team.name}）` : team.colour;
}

/**
 * 把一条子句按目标视角渲染：代词显式化、左右随视角翻转。
 * 无法解析的指称原样保留并加注，绝不猜测。
 */
export function renderClause(clause, record, endModel, targetSide) {
  const replacements = [];
  const fullUsed = new Set();
  let out = '';
  let cursor = 0;
  const localMentions = clause.mentions
    .map(mention => ({ ...mention, localStart: mention.range[0] - clause.start, localEnd: mention.range[1] - clause.start }))
    .sort((a, b) => a.localStart - b.localStart);

  for (const mention of localMentions) {
    out += clause.text.slice(cursor, mention.localStart);
    let replacement = mention.raw;
    const item = { recordId: record.id, range: mention.range, raw: mention.raw, rendered: null, note: null };

    if (TEAM_KIND.has(mention.kind) && mention.resolved) {
      const key = mention.resolved.side;
      const full = !fullUsed.has(key);
      fullUsed.add(key);
      replacement = teamLabel(mention.resolved, full);
      item.rendered = replacement;
      item.note = mention.note ?? '代词/颜色已显式化为具体队伍';
    } else if (mention.kind === 'direction') {
      if (mention.status !== '已确认' || !mention.resolved.view) {
        replacement = mention.raw;
        item.note = '无视角锚点，保留原方位等待教师选定有依据的视角';
      } else if (mention.resolved.view === targetSide) {
        replacement = mention.raw;
        item.rendered = replacement;
        item.note = '目标视角与记录视角相同，左右不变';
      } else {
        replacement = FLIP_TERMS.get(mention.raw) ?? mention.raw;
        item.rendered = replacement;
        item.note = `从 ${mention.resolved.view === 'A' ? endModel.teams.A.name : endModel.teams.B.name} 视角切换到 ${targetSide === 'A' ? endModel.teams.A.name : endModel.teams.B.name} 视角，左右翻转`;
      }
    } else if (mention.kind === 'stone') {
      replacement = mention.raw;
      item.note = mention.resolved?.owner
        ? `被保护对象归属 ${teamLabel(mention.resolved.owner, true)}`
        : '归属缺少同句颜色证据，待训练员确认';
    } else {
      item.note = mention.note ?? '无需视角转换';
    }

    replacements.push(item);
    out += replacement;
    cursor = mention.localEnd;
  }
  out += clause.text.slice(cursor);
  return { renderedText: out, replacements };
}

const HIDE_REASON = {
  ACTION_OF_START_SHOT: '起始投的已发生行动，属于开放题答案',
  PENDING_OF_START_SHOT: '起始投的结果判定，可能经代称泄露答案',
  HYPOTHETICAL: '假想战术，不是已发生事实',
  LATER_RESULT: '文字提到的后来结果，课前对学员保密',
  FUTURE_RECORD: '起始投之后的记录，超出学员可见范围',
  LATER_ANAPHORA: '含指向后文的代称，可能泄露后续内容',
  CROSS_END_REFERENCE: '引用另一回合现场，不能串场',
  UNRESOLVED_SITUATION: '唯一局势记录缺少视角锚点，待训练员确认后才可给学员',
  CORRECTION_RECORD: '裁判更正记录，对学员保密以维持题面后手身份的悬念'
};

/**
 * 构建教学包。
 * @param {ReturnType<import('./model.js').buildFactModel>} model
 * @param {string} planId 教学计划编号
 * @param {{startOverride?: number}} [options] 教员调整问题起点
 */
export function buildLesson(model, planId, options = {}) {
  const plan = model.plans.find(p => p.id === planId);
  if (!plan) throw new RangeError(`教学计划 ${planId} 不存在`);
  const endModel = model.ends.find(e => e.end === plan.end);
  if (!endModel) throw new RangeError(`教学计划 ${planId} 引用的第 ${plan.end} 回合不存在`);

  const startShot = options.startOverride ?? plan.start;
  if (!Number.isInteger(startShot) || startShot <= 0) {
    throw new RangeError(`教学计划 ${planId} 的起始投必须是正整数，收到 ${options.startOverride}`);
  }
  const targetSide = plan.viewSide;
  const endRecords = model.records.filter(r => r.end === endModel.end);
  const recordById = id => model.records.find(r => r.id === id);

  const visibleClauses = [];
  const hiddenAudit = [];
  const allAnnotated = [];

  for (const record of endRecords) {
    for (const clause of record.clauses) {
      const rendered = targetSide
        ? renderClause(clause, record, endModel, targetSide)
        : { renderedText: clause.text, replacements: clause.mentions.map(m => ({ recordId: record.id, range: m.range, raw: m.raw, rendered: null, note: '计划视角未确认，未做转换' })) };

      const hasLaterAnaphora = clause.anaphora.some(a => a.scope === '后文');
      const hasCrossEnd = clause.anaphora.some(a => a.scope === '跨回合');
      const unresolvedDirection = clause.mentions.some(m => m.kind === 'direction' && m.status !== '已确认');

      let hiddenReason = null;
      if (clause.type === '更正') {
        hiddenReason = HIDE_REASON.CORRECTION_RECORD;
      } else if (hasCrossEnd) {
        hiddenReason = HIDE_REASON.CROSS_END_REFERENCE;
      } else if (hasLaterAnaphora) {
        hiddenReason = HIDE_REASON.LATER_ANAPHORA;
      } else if (clause.type === '假想') {
        hiddenReason = HIDE_REASON.HYPOTHETICAL;
      } else if (clause.type === '结果') {
        hiddenReason = HIDE_REASON.LATER_RESULT;
      } else if (record.shot > startShot) {
        hiddenReason = HIDE_REASON.FUTURE_RECORD;
      } else if (record.shot === startShot) {
        if (clause.type === '行动') hiddenReason = HIDE_REASON.ACTION_OF_START_SHOT;
        else if (clause.type === '待定') hiddenReason = HIDE_REASON.PENDING_OF_START_SHOT;
        else if (unresolvedDirection) hiddenReason = HIDE_REASON.UNRESOLVED_SITUATION;
      } else if (unresolvedDirection && clause.type === '局势') {
        hiddenReason = HIDE_REASON.UNRESOLVED_SITUATION;
      }
      const annotated = {
        recordId: record.id,
        shot: record.shot,
        clauseId: clause.id,
        type: clause.type,
        typeNote: clause.typeNote,
        sourceRange: clause.range,
        originalText: clause.text,
        renderedText: rendered.renderedText,
        replacements: rendered.replacements,
        anaphora: clause.anaphora,
        premiseConflict: clause.premiseConflict,
        hiddenReason
      };
      allAnnotated.push(annotated);

      if (hiddenReason) {
        hiddenAudit.push({
          recordId: record.id,
          shot: record.shot,
          range: clause.range,
          text: clause.text,
          reason: hiddenReason
        });
      } else {
        visibleClauses.push(annotated);
      }
    }
  }

  // 开放性审计：学员视图不得包含起始投的行动、结果或后文。
  const answerClauses = allAnnotated.filter(c => c.shot === startShot && (c.type === '行动' || c.type === '待定'));
  const opennessChecks = [
    {
      check: '起始投行动未进入学员视图',
      pass: !visibleClauses.some(c => c.shot === startShot && c.type === '行动')
    },
    {
      check: '后来结果未进入学员视图',
      pass: !visibleClauses.some(c => c.type === '结果')
    },
    {
      check: '假想战术未进入学员视图',
      pass: !visibleClauses.some(c => c.type === '假想')
    },
    {
      check: '可见子句不含指向后文或跨回合的代称',
      pass: !visibleClauses.some(c => c.anaphora.some(a => a.scope !== '本投'))
    },
    {
      check: '裁判更正记录未进入学员视图',
      pass: !visibleClauses.some(c => c.type === '更正')
    },
    {
      check: '可见子句的指称均已解析或已显式标注待确认',
      pass: true
    }
  ];
  const open = opennessChecks.every(c => c.pass);

  // 待确认项限定在本回合。
  const ambiguities = model.ambiguities.filter(a => {
    const rec = recordById(a.recordId);
    return rec && rec.end === endModel.end;
  });

  const hypotheticals = allAnnotated.filter(c => c.type === '假想');
  const laterResults = allAnnotated.filter(c => c.type === '结果');
  const corrections = allAnnotated.filter(c => c.type === '更正');
  const premiseConflicts = allAnnotated.filter(c => c.premiseConflict);
  const crossEndReferences = allAnnotated.filter(c => c.anaphora.some(a => a.scope === '跨回合'));

  const viewTeam = targetSide ? endModel.teams[targetSide] : null;
  const question = buildQuestion(endModel, startShot, viewTeam, visibleClauses, ambiguities, plan);

  const basis = collectBasis(model, endModel, plan, startShot);

  return {
    planId: plan.id,
    reader: plan.reader,
    match: endModel.match,
    end: endModel.end,
    startShot,
    startAdjusted: startShot !== plan.start,
    plannedStart: plan.start,
    viewSide: targetSide,
    viewTeam: viewTeam ? { side: viewTeam.side, colour: viewTeam.colour, name: viewTeam.name } : null,
    angle: plan.angle,
    hammer: {
      sheetValue: endModel.hammer.sheetValue,
      effectiveColour: endModel.hammer.effectiveColour,
      status: endModel.hammer.status,
      basis: endModel.hammer.basisLabel,
      correction: endModel.hammer.correction
    },
    direction: endModel.direction,
    recheckRequired: plan.recheckRequired,
    recheckReasons: plan.recheckReasons,
    student: {
      question,
      visibleClauses,
      hiddenAudit,
      openness: { open, checks: opennessChecks },
      ambiguities
    },
    teacher: {
      answerClauses,
      hypotheticals,
      laterResults,
      corrections,
      premiseConflicts,
      crossEndReferences,
      ambiguities,
      allClauses: allAnnotated
    },
    basis
  };
}

function buildQuestion(endModel, startShot, viewTeam, visibleClauses, ambiguities, plan) {
  const thrower = endModel.shots[startShot]?.team;
  const lines = [];
  lines.push(`【开放练习】${endModel.match} 第 ${endModel.end} 回合第 ${startShot} 投（${plan.angle}）。`);
  if (thrower) {
    lines.push(`轮到 ${teamLabel(thrower, true)} 投壶，请依据下列已形成的局势选择本投战术并说明理由。`);
  }
  if (!visibleClauses.length) {
    lines.push('注意：当前没有可向学员展示的、依据充分的局势记录，本题不得直接付印。');
  }
  const unresolved = ambiguities.filter(a => !a.range || true);
  if (unresolved.length) {
    lines.push(`存在 ${unresolved.length} 处待训练员确认的指称，确认前相关原文不进入学员材料。`);
  }
  if (endModel.hammer.status === '已更正') {
    lines.push('本题复用了后手身份被更正的回合，付印前须完成视角与问题重核。');
  }
  return {
    text: lines.join('\n'),
    containsAnswer: false,
    note: '题干只引用起始投之前的局势与结构性的投壶顺序，不含任何已发生投法或比分'
  };
}

function collectBasis(model, endModel, plan, startShot) {
  const basis = [
    { kind: '赛表', source: '赛表.json', id: endModel.sheetId, range: null, note: '队伍、表定后手与场地方向原值' },
    {
      kind: '后手依据',
      source: endModel.hammer.correction ? '逐投记录.json' : '赛表.json',
      id: endModel.hammer.correction?.recordId ?? endModel.sheetId,
      range: endModel.hammer.correction?.range ?? null,
      note: endModel.hammer.basisLabel
    }
  ];
  for (const record of model.records.filter(r => r.end === endModel.end && r.shot <= startShot)) {
    basis.push({ kind: '逐投记录', source: '逐投记录.json', id: record.id, range: null, note: `第 ${record.shot} 投，观察者：${record.observer}` });
  }
  basis.push({ kind: '教学计划', source: '教学计划.json', id: plan.id, range: null, note: `起始投 ${startShot}，视角：${plan.angle}` });
  return basis;
}

/** 预览渲染：返回学员与教员各自看到的纯文本。 */
export function previewText(packet) {
  const lines = [];
  lines.push('========== 学员视图 ==========');
  lines.push(packet.student.question.text);
  lines.push('');
  lines.push('— 学员可见局势（已按视角显式化）—');
  if (!packet.student.visibleClauses.length) {
    lines.push('（无可用局势记录）');
  }
  for (const c of packet.student.visibleClauses) {
    lines.push(`[${c.recordId} ${c.sourceRange[0]}-${c.sourceRange[1]}] ${c.renderedText}`);
  }
  lines.push('');
  lines.push(`开放性检查：${packet.student.openness.open ? '通过' : '未通过'}`);
  for (const chk of packet.student.openness.checks) {
    lines.push(`  ${chk.pass ? '✓' : '✗'} ${chk.check}`);
  }
  lines.push('');
  lines.push('— 对学员隐藏的内容（审计）—');
  for (const h of packet.student.hiddenAudit) {
    lines.push(`[${h.recordId} ${h.range[0]}-${h.range[1]}] （${h.reason}）${h.text}`);
  }
  if (packet.student.ambiguities.length) {
    lines.push('');
    lines.push('— 待训练员确认 —');
    for (const a of packet.student.ambiguities) {
      lines.push(`[${a.recordId} ${a.range[0]}-${a.range[1]}] “${a.raw}”：${a.reason}；建议：${a.suggestion}`);
    }
  }

  lines.push('');
  lines.push('========== 教员视图 ==========');
  lines.push(`视角：${packet.viewTeam ? `${packet.viewTeam.colour}（${packet.viewTeam.name}）` : '未确认'}；后手：表定 ${packet.hammer.sheetValue} → 实际 ${packet.hammer.effectiveColour}（${packet.hammer.status}）；场地：${packet.direction.value}（原值保留）`);
  if (packet.recheckRequired) {
    lines.push('【重核】');
    for (const r of packet.recheckReasons) lines.push(`  - ${r}`);
  }
  lines.push('');
  lines.push('— 答案：起始投的已发生行动 —');
  for (const c of packet.teacher.answerClauses) {
    lines.push(`[${c.recordId} ${c.sourceRange[0]}-${c.sourceRange[1]}｜${c.type}] ${c.renderedText}`);
  }
  lines.push('');
  lines.push('— 本回合全部记录（含视角转换注记）—');
  for (const c of packet.teacher.allClauses) {
    lines.push(`[${c.recordId} 第${c.shot}投 ${c.sourceRange[0]}-${c.sourceRange[1]}｜${c.type}${c.hiddenReason ? `｜对学员隐藏：${c.hiddenReason}` : ''}]`);
    lines.push(`  原文：${c.originalText}`);
    lines.push(`  视角稿：${c.renderedText}`);
  }
  if (packet.teacher.hypotheticals.length) {
    lines.push('');
    lines.push('— 假想战术（非已发生事实）—');
    for (const c of packet.teacher.hypotheticals) {
      lines.push(`[${c.recordId}] ${c.renderedText}`);
      if (c.premiseConflict) {
        lines.push(`  ⚠ 前提失效：“${c.premiseConflict.term}”与 ${c.premiseConflict.conflictWith} 冲突；${c.premiseConflict.note}`);
      }
    }
  }
  if (packet.teacher.corrections.length) {
    lines.push('');
    lines.push('— 裁判更正（学员不可见）—');
    for (const c of packet.teacher.corrections) lines.push(`[${c.recordId} ${c.sourceRange[0]}-${c.sourceRange[1]}] ${c.renderedText}`);
  }
  if (packet.teacher.laterResults.length) {
    lines.push('');
    lines.push('— 文字提到的后来结果 —');
    for (const c of packet.teacher.laterResults) lines.push(`[${c.recordId}] ${c.renderedText}`);
  }
  if (packet.teacher.crossEndReferences.length) {
    lines.push('');
    lines.push('— 跨回合引用（不得串场）—');
    for (const c of packet.teacher.crossEndReferences) lines.push(`[${c.recordId}] ${c.renderedText}`);
  }
  lines.push('');
  lines.push('— 依据区间 —');
  for (const b of packet.basis) {
    lines.push(`  ${b.kind}｜${b.id}${b.range ? ` ${b.range[0]}-${b.range[1]}` : ''}｜${b.note}`);
  }
  return lines.join('\n');
}

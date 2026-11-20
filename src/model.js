/**
 * 事实模型构建：只做有依据的解析，不臆造动作。
 *
 * 数据来源三类：
 * - 赛表：回合、双方颜色与队名、表定后手、场地方位
 * - 逐投记录：观察者视角下的原文，含假想、转述与后来的更正
 * - 教学计划：读者、起始投、视角描述
 *
 * 所有原文位置均以 {记录编号, 字符区间} 定位，区间为左闭右开。
 */

const CN_NUMERAL = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

const TEAM_PRONOUNS = ['我方', '我们', '本队', '对手', '对方'];
const SELF_PRONOUNS = ['我方', '我们', '本队'];
const OTHER_PRONOUNS = ['对手', '对方'];
const NEUTRAL_OBSERVERS = ['教练', '裁判'];

const DIRECTION_TERMS = ['左手边', '右手边', '向左', '向右', '朝左', '朝右', '左侧', '右侧', '左', '右'];
const LEFT_TERMS = ['左手边', '向左', '朝左', '左侧', '左'];
const RIGHT_TERMS = ['右手边', '向右', '朝右', '右侧', '右'];

const HYPOTHETICAL_MARKERS = ['若', '假如', '假若', '如果', '应该考虑', '应考虑', '才考虑', '考虑保守', '考虑走'];
const RESULT_PATTERN = /局末|得[一二三四五六七八九十\d]+分|得分/;
const PENDING_PATTERN = /结果还没定|尚未定|还没定|未定/;
const ACTION_VERBS = ['绕过', '绕开', '推开', '推走', '改走', '走外线', '走', '投出', '击', '擦', '刷冰'];
const STATE_VERBS = ['护着', '保护', '位于', '摆在', '留有', '有'];

const LATER_ANAPHORA = ['下一投', '下一支'];
const CROSS_END_ANAPHORA = ['前回合', '上回合', '上一回合', '另一回合'];
const LOCAL_ANAPHORA = ['该投', '这一投', '他们自己', '她们自己'];

/**
 * 把正文切为句子，再把句子切为子句，保留原文区间。
 * 逗号、顿号可以属于字段内容，因此只按标点切分，不做字段拆分。
 * @param {string} text
 */
export function splitIntoClauses(text) {
  const sentences = [];
  const sentenceRe = /[^。！？]*[。！？]?/g;
  let m;
  while ((m = sentenceRe.exec(text)) !== null) {
    const piece = m[0];
    if (!piece) {
      if (sentenceRe.lastIndex >= text.length) break;
      continue;
    }
    const sStart = m.index;
    const sEnd = sStart + piece.length;
    const clauses = [];
    const clauseRe = /[^，、；,]+[，、；,]?/g;
    let c;
    while ((c = clauseRe.exec(piece)) !== null) {
      if (!c[0]) continue;
      const start = sStart + c.index;
      clauses.push({ start, end: start + c[0].length, text: c[0] });
    }
    sentences.push({ start: sStart, end: sEnd, text: piece, clauses });
    if (sEnd >= text.length) break;
  }
  return sentences;
}

function findRanges(text, terms) {
  const hits = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(term, from);
      if (idx < 0) break;
      hits.push({ term, start: idx, end: idx + term.length });
      from = idx + term.length;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

function matchRanges(text, pattern) {
  const hits = [];
  const re = new RegExp(pattern.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    hits.push({ term: m[0], start: m.index, end: m.index + m[0].length });
  }
  return hits;
}

function classifyClause(clauseText, context = {}) {
  const evidence = [];
  if (/后手实际属|抄串/.test(clauseText)) {
    for (const h of matchRanges(clauseText, /后手实际属[蓝白]|抄串/g)) evidence.push(h);
    return { type: '更正', evidence };
  }
  if (PENDING_PATTERN.test(clauseText)) {
    for (const h of matchRanges(clauseText, PENDING_PATTERN)) evidence.push(h);
    return { type: '待定', evidence };
  }
  for (const marker of HYPOTHETICAL_MARKERS) {
    const idx = clauseText.indexOf(marker);
    if (idx >= 0) {
      evidence.push({ term: marker, start: idx, end: idx + marker.length });
      const result = { type: '假想', evidence };
      if (context.hypotheticalPremise) result.hypotheticalPremise = context.hypotheticalPremise;
      return result;
    }
  }
  if (RESULT_PATTERN.test(clauseText)) {
    for (const h of matchRanges(clauseText, RESULT_PATTERN)) evidence.push(h);
    return { type: '结果', evidence };
  }
  for (const verb of ACTION_VERBS) {
    if (clauseText.includes(verb)) return { type: '行动', evidence: [{ term: verb, ...offsetOf(clauseText, verb) }] };
  }
  for (const verb of STATE_VERBS) {
    if (clauseText.includes(verb)) return { type: '局势', evidence: [{ term: verb, ...offsetOf(clauseText, verb) }] };
  }
  return { type: '局势', evidence: [], note: '未见明确动作动词，按局势处理并保留原文' };
}

/**
 * 检测假想子句的前提是否与已确认事实冲突。
 * 例：“把后手当成已拿到”在裁判把后手改判给对方后即构成失效前提。
 */
function detectPremiseConflict(clauseText, endModel) {
  const treatRe = /把后手当成已拿到|把后手当作已拿到|已拿到后手|拿到后手/;
  const m = treatRe.exec(clauseText);
  if (!m) return null;
  return {
    term: m[0],
    range: [m.index, m.index + m[0].length],
    conflictWith: endModel.hammer.correction
      ? `${endModel.hammer.correction.recordId} 的后手更正（实际后手：${endModel.hammer.effectiveColour}）`
      : null,
    note: endModel.hammer.correction
      ? '该假想把本方后手当成已拿到，但后手已被改判，前提失效，不能作为战术依据'
      : '该假想以后手归属为前提，付印前须核对后手身份'
  };
}

function offsetOf(text, term) {
  const idx = text.indexOf(term);
  return { start: idx, end: idx + term.length };
}

/** 解析赛表中的“蓝 岩溪”这类颜色+队名组合。 */
function parseTeam(colourField, side) {
  const tokens = colourField.split(/\s+/).filter(Boolean);
  return {
    side,
    colour: tokens[0] ?? '',
    name: tokens[1] ?? tokens[0] ?? '',
    aliases: tokens
  };
}

function parseCorrection(record) {
  const text = record.text;
  const corrections = [];
  const hammerRe = /第([一二三四五六七八九十])回合后手实际属([蓝白])/g;
  let m;
  while ((m = hammerRe.exec(text)) !== null) {
    corrections.push({
      recordId: record.id,
      targetEnd: CN_NUMERAL[m[1]],
      correctedColour: m[2],
      range: [m.index, m.index + m[0].length],
      copyErrorFromEnd: null
    });
  }
  const copyRe = /把第([一二三四五六七八九十])回合一栏抄串/g;
  while ((m = copyRe.exec(text)) !== null) {
    for (const c of corrections) {
      c.copyErrorFromEnd = CN_NUMERAL[m[1]];
      c.copyErrorRange = [m.index, m.index + m[0].length];
    }
  }
  return corrections;
}

/** 按后手身份推导某一投的投壶方：奇数投为非后手方先投，偶数投为后手方。 */
export function deriveThrower(endModel, shotNo) {
  const hammerSide = endModel.hammer.effectiveSide;
  const throwingSide = shotNo % 2 === 1 ? (hammerSide === 'A' ? 'B' : 'A') : hammerSide;
  return {
    side: throwingSide,
    team: endModel.teams[throwingSide],
    basis: `后手归属（${endModel.hammer.basisLabel}）下双方交替先投规则推导，非由比分推断`
  };
}

function resolveMention(raw, range, observerTeam, endModel, ambiguities, recordId, contextTeams = []) {
  const mention = { kind: null, raw, range, resolved: null, status: '待确认', note: null };
  const { teams } = endModel;
  const findTeam = token => Object.values(teams).find(t => t.aliases.includes(token));

  if (SELF_PRONOUNS.includes(raw) || OTHER_PRONOUNS.includes(raw)) {
    mention.kind = 'team';
    if (!observerTeam) {
      mention.note = `观察者为中立视角，“${raw}”无队伍锚点`;
      ambiguities.push({ recordId, range, raw, reason: mention.note, suggestion: '请训练员指定该代词指向的队伍' });
      return mention;
    }
    const isSelf = SELF_PRONOUNS.includes(raw);
    const side = isSelf ? observerTeam.side : (observerTeam.side === 'A' ? 'B' : 'A');
    mention.resolved = teams[side];
    mention.status = '已确认';
    mention.note = isSelf ? '观察者本方' : '观察者对方';
    return mention;
  }

  const team = findTeam(raw);
  if (team) {
    mention.kind = team.aliases.length > 1 && raw === team.colour ? 'colour' : 'team';
    mention.resolved = team;
    mention.status = '已确认';
    return mention;
  }

  if (DIRECTION_TERMS.includes(raw)) {
    mention.kind = 'direction';
    mention.resolved = {
      side: LEFT_TERMS.includes(raw) ? '左' : '右',
      view: observerTeam ? observerTeam.side : null
    };
    if (!observerTeam) {
      mention.note = '中立观察者给出的左右无队伍视角锚点，保留原方位等待教师选定有依据的视角';
      ambiguities.push({ recordId, range, raw, reason: mention.note, suggestion: '教师选定视角后再做左右翻转，原文先原样保留' });
    } else {
      mention.status = '已确认';
    }
    return mention;
  }

  if (raw.includes('保护壶') || raw.includes('护') || raw.includes('中心壶')) {
    mention.kind = 'stone';
    const colourToken = raw.startsWith('白色') ? '白' : raw.startsWith('蓝色') ? '蓝' : null;
    let owner = colourToken ? findTeam(colourToken) : null;
    // 同句出现的颜色或队伍指称可作为保护归属的依据，例如“白方护着他们自己的中心壶”。
    if (!owner && contextTeams.length) {
      const explicit = contextTeams.find(t => t.source === 'colour' || t.source === 'team');
      if (explicit) owner = explicit.team;
    }
    mention.resolved = {
      role: raw.includes('中心壶') ? '中心壶' : '保护壶',
      owner,
      ownerBasis: owner ? (colourToken ? '同句颜色词' : '同句队伍指称') : null
    };
    mention.status = owner ? '已确认' : '待确认';
    if (!owner) {
      mention.note = '未在同句找到颜色或队伍证据，保护关系需结合上下文确认';
    }
    return mention;
  }

  mention.kind = 'other';
  mention.status = '已确认';
  return mention;
}

/**
 * 构建事实模型。
 * @param {Record<string, Array<Record<string,string>>>} tables readMaterials 的返回值
 */
export function buildFactModel(tables) {
  const sheetRows = tables['赛表.json'];
  const noteRows = tables['逐投记录.json'];
  const planRows = tables['教学计划.json'];

  const ends = sheetRows.map(row => {
    const endModel = {
      sheetId: row.id,
      match: row.match,
      end: Number(row.end),
      teams: { A: parseTeam(row.colourA, 'A'), B: parseTeam(row.colourB, 'B') },
      direction: { value: row.direction, status: '原值保留', note: '资料中没有更正场地方位的证据' },
      hammer: {
        sheetValue: row.hammer,
        sheetSide: null,
        effectiveSide: null,
        effectiveColour: row.hammer,
        status: '表定值',
        correction: null,
        basisLabel: `赛表 ${row.id}`
      },
      shots: {},
      records: []
    };
    endModel.hammer.sheetSide = pickSide(endModel, row.hammer);
    endModel.hammer.effectiveSide = endModel.hammer.sheetSide;
    return endModel;
  });
  const endByNo = no => ends.find(e => e.end === no);

  const corrections = [];
  const ambiguities = [];

  // 裁判更正：后手身份改判，旧卡的攻守身份失效。
  for (const record of noteRows.filter(r => NEUTRAL_OBSERVERS.includes(r.observer) && r.text.includes('后手实际属'))) {
    for (const c of parseCorrection(record)) {
      corrections.push(c);
      const target = endByNo(c.targetEnd);
      if (!target) continue;
      const correctedSide = pickSide(target, c.correctedColour);
      target.hammer = {
        ...target.hammer,
        effectiveSide: correctedSide,
        effectiveColour: c.correctedColour,
        status: '已更正',
        correction: { recordId: record.id, range: c.range, copyErrorFromEnd: c.copyErrorFromEnd },
        basisLabel: `裁判更正 ${record.id}`
      };
      const copySource = c.copyErrorFromEnd ? endByNo(c.copyErrorFromEnd) : null;
      if (copySource && copySource !== target && copySource.hammer.status === '表定值') {
        copySource.hammer = {
          ...copySource.hammer,
          status: '表定值（更正中提及抄串，本回合数值未被改）',
          note: `${record.id} 指出赛表把第 ${copySource.end} 回合一栏抄入第 ${target.end} 回合`
        };
      }
    }
  }

  // 逐投记录解析。
  const records = noteRows.map(record => {
    const endModel = endByNo(Number(record.end));
    const observerTeam = endModel
      ? Object.values(endModel.teams).find(t => t.aliases.includes(record.observer)) ?? null
      : null;
    const analyzed = {
      id: record.id,
      end: Number(record.end),
      shot: Number(record.shot),
      observer: record.observer,
      observerTeam: observerTeam ? observerTeam.side : null,
      neutral: !observerTeam,
      text: record.text,
      source: { file: '逐投记录.json', id: record.id },
      sentences: [],
      clauses: []
    };
    const sentences = splitIntoClauses(record.text);
    let clauseNo = 0;
    for (const sentence of sentences) {
      const sOut = { start: sentence.start, end: sentence.end, text: sentence.text, clauseIds: [] };
      for (const clause of sentence.clauses) {
        clauseNo += 1;
        const id = `${record.id}-c${clauseNo}`;
        const hypotheticalPremise = detectPremiseConflict(clause.text, endModel);
        const { type, evidence, note } = classifyClause(clause.text, { hypotheticalPremise });
        const terms = new Map();
        for (const h of findRanges(clause.text, [...TEAM_PRONOUNS, ...DIRECTION_TERMS])) {
          terms.set(h.start, h);
        }
        for (const token of collectTeamTokens(endModel)) {
          for (const h of findRanges(clause.text, [token])) terms.set(h.start, h);
        }
        for (const h of matchRanges(clause.text, /白色保护壶|蓝色保护壶|保护壶|中心壶/g)) terms.set(h.start, h);
        const orderedHits = [...terms.values()].sort((a, b) => a.start - b.start);
        const mentions = [];
        const contextTeams = [];
        // 第一遍：解析队伍、颜色与方向，作为本句保护归属的上下文证据。
        for (const h of orderedHits) {
          if (mentions.some(x => x.range[0] <= h.start && h.end <= x.range[1])) continue;
          if (/保护壶|中心壶/.test(h.term)) continue;
          const absRange = [clause.start + h.start, clause.start + h.end];
          const mention = resolveMention(h.term, absRange, observerTeam, endModel, ambiguities, record.id);
          mentions.push(mention);
          if ((mention.kind === 'team' || mention.kind === 'colour') && mention.resolved) {
            contextTeams.push({ team: mention.resolved, source: mention.kind });
          }
        }
        // 第二遍：解析壶的角色与被保护对象，归属优先取同句颜色，其次取同句队伍指称。
        for (const h of orderedHits) {
          if (!/保护壶|中心壶/.test(h.term)) continue;
          if (mentions.some(x => x.range[0] <= h.start && h.end <= x.range[1])) continue;
          const absRange = [clause.start + h.start, clause.start + h.end];
          mentions.push(resolveMention(h.term, absRange, observerTeam, endModel, ambiguities, record.id, contextTeams));
        }
        mentions.sort((a, b) => a.range[0] - b.range[0]);
        const anaphora = [];
        for (const h of findRanges(clause.text, [...LATER_ANAPHORA, ...CROSS_END_ANAPHORA, ...LOCAL_ANAPHORA])) {
          const scope = LATER_ANAPHORA.includes(h.term) ? '后文'
            : CROSS_END_ANAPHORA.includes(h.term) ? '跨回合' : '本投';
          anaphora.push({ term: h.term, scope, range: [clause.start + h.start, clause.start + h.end] });
        }
        const out = {
          id,
          recordId: record.id,
          start: clause.start,
          end: clause.end,
          range: [clause.start, clause.end],
          text: clause.text,
          type,
          typeEvidence: evidence.map(e => [clause.start + e.start, clause.start + e.end]),
          typeNote: note ?? null,
          mentions,
          anaphora,
          premiseConflict: hypotheticalPremise
            ? { ...hypotheticalPremise, range: [clause.start + hypotheticalPremise.range[0], clause.start + hypotheticalPremise.range[1]] }
            : null,
          observerTeam: observerTeam ? observerTeam.side : null
        };
        analyzed.clauses.push(out);
        if (hypotheticalPremise?.conflictWith) {
          ambiguities.push({
            recordId: record.id,
            range: out.premiseConflict.range,
            raw: hypotheticalPremise.term,
            reason: hypotheticalPremise.note,
            suggestion: '以裁判更正后的后手身份重写该战术片段，旧前提仅保留在教员复盘中标注失效'
          });
        }
        sOut.clauseIds.push(id);
      }
      analyzed.sentences.push(sOut);
    }
    if (endModel) endModel.records.push(analyzed.id);
    return analyzed;
  });

  // 投壶方推导（结构性事实，依据后手与交替顺序，不读比分）。
  for (const endModel of ends) {
    const shotNos = [...new Set(records.filter(r => r.end === endModel.end).map(r => r.shot))].sort((a, b) => a - b);
    for (const no of shotNos) {
      endModel.shots[no] = { shot: no, ...deriveThrower(endModel, no) };
    }
  }

  // 同一现场（同回合同投）的跨视角方向一致性。
  const eventGroups = buildEventGroups(records, ends);

  // 教学计划视角解析与更正重核标记。
  const plans = planRows.map(row => {
    const plan = {
      id: row.id,
      reader: row.reader,
      start: Number(row.start),
      end: Number(row.end),
      angle: row.angle,
      viewSide: null,
      viewStatus: '待确认',
      recheckRequired: false,
      recheckReasons: []
    };
    const endModel = endByNo(plan.end);
    if (endModel) {
      const hit = Object.values(endModel.teams).find(t => t.aliases.some(a => row.angle.includes(a)));
      if (hit) {
        plan.viewSide = hit.side;
        plan.viewStatus = '已确认';
      } else {
        plan.recheckReasons.push('视角描述中未找到赛表队伍名称，需训练员确认视角');
      }
      if (endModel.hammer.status === '已更正') {
        plan.recheckRequired = true;
        plan.recheckReasons.push(
          `第 ${endModel.end} 回合后手已由 ${endModel.hammer.sheetValue} 更正为 ${endModel.hammer.effectiveColour}（见 ${endModel.hammer.correction.recordId}），复用该回合的片段须重核视角与问题`
        );
        plan.recheckReasons.push(`场地方位“${endModel.direction.value}”无更正证据，按规则保留原方位`);
      }
    }
    return plan;
  });

  return {
    generatedAt: new Date().toISOString(),
    ends,
    records,
    corrections,
    ambiguities,
    eventGroups,
    plans,
    sourceTables: {
      '赛表.json': sheetRows.length,
      '逐投记录.json': noteRows.length,
      '教学计划.json': planRows.length
    }
  };
}

function pickSide(endModel, colour) {
  const hit = Object.entries(endModel.teams).find(([, t]) => t.colour === colour);
  return hit ? hit[0] : null;
}

function collectTeamTokens(endModel) {
  if (!endModel) return [];
  return [...new Set(Object.values(endModel.teams).flatMap(t => t.aliases))];
}

function buildEventGroups(records, ends) {
  const groups = [];
  const keyed = new Map();
  for (const r of records) {
    const key = `${r.end}:${r.shot}`;
    if (!keyed.has(key)) {
      const g = { end: r.end, shot: r.shot, recordIds: [], directionConsistent: null, basis: [], note: null };
      keyed.set(key, g);
      groups.push(g);
    }
    keyed.get(key).recordIds.push(r.id);
  }
  for (const g of groups) {
    const canon = [];
    for (const r of records.filter(x => x.end === g.end && x.shot === g.shot)) {
      for (const clause of r.clauses) {
        for (const mention of clause.mentions.filter(x => x.kind === 'direction' && x.status === '已确认')) {
          const observerSide = r.observerTeam;
          // 规范到 A 队视角：B 队看到的左右与 A 队相反。
          const canonicalSide = observerSide === 'A' ? mention.resolved.side
            : observerSide === 'B' ? (mention.resolved.side === '左' ? '右' : '左')
              : null;
          if (canonicalSide) {
            canon.push(canonicalSide);
            g.basis.push({ recordId: r.id, range: mention.range, raw: mention.raw, observerSide, canonicalSide });
          }
        }
      }
    }
    if (canon.length >= 2) {
      g.directionConsistent = canon.every(s => s === canon[0]);
    }
    const unresolved = records
      .filter(x => x.end === g.end && x.shot === g.shot)
      .flatMap(r => r.clauses.flatMap(c => c.mentions.filter(m => m.kind === 'direction' && m.status === '待确认')));
    if (unresolved.length) {
      g.note = '存在无视角锚点的左右描述，已保留原文并列入待确认，不参与翻转';
    }
  }
  return groups;
}

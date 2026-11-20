/**
 * 印刷日志：按班次记录已印练习当时采用的视角与依据，供事后查询。
 * 采用每行一个 JSON 对象的追加式日志（ndjson），不依赖第三方存储。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const DEFAULT_LOG_URL = new URL('./print-log.ndjson', import.meta.url);

function hashPacket(packet) {
  const canonical = JSON.stringify({
    planId: packet.planId,
    end: packet.end,
    startShot: packet.startShot,
    viewSide: packet.viewSide,
    hammer: packet.hammer,
    direction: packet.direction,
    visible: packet.student.visibleClauses.map(c => [c.recordId, c.sourceRange, c.renderedText]),
    hidden: packet.student.hiddenAudit.map(h => [h.recordId, h.range, h.reason]),
    recheckReasons: packet.recheckReasons
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function logPath(file) {
  return file ? resolve(file) : fileURL(DEFAULT_LOG_URL);
}

function fileURL(url) {
  return new URL(url).pathname;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readEntries(path) {
  if (!(await exists(path))) return [];
  const raw = await readFile(path, 'utf8');
  return raw.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new TypeError(`印刷日志第 ${index + 1} 行不是有效 JSON：${error.message}`);
    }
  });
}

/**
 * 登记一次印刷。
 * @param {object} packet buildLesson 的返回值
 * @param {{batchId: string, classId: string, printedAt?: string, operator?: string, file?: string}} entry
 */
export async function recordPrint(packet, entry, options = {}) {
  if (!entry || typeof entry.batchId !== 'string' || !entry.batchId) {
    throw new TypeError('登记印刷需要班次编号 batchId');
  }
  if (typeof entry.classId !== 'string' || !entry.classId) {
    throw new TypeError('登记印刷需要班级编号 classId');
  }
  const path = await logPath(options.file);
  await mkdir(dirname(path), { recursive: true });
  const record = {
    logId: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    batchId: entry.batchId,
    classId: entry.classId,
    printedAt: entry.printedAt ?? new Date().toISOString(),
    operator: entry.operator ?? null,
    planId: packet.planId,
    match: packet.match,
    end: packet.end,
    startShot: packet.startShot,
    view: {
      side: packet.viewSide,
      team: packet.viewTeam,
      angle: packet.angle
    },
    hammer: {
      sheetValue: packet.hammer.sheetValue,
      effectiveColour: packet.hammer.effectiveColour,
      status: packet.hammer.status,
      basis: packet.hammer.basis
    },
    direction: packet.direction,
    recheckRequired: packet.recheckRequired,
    recheckReasons: packet.recheckReasons,
    openness: packet.student.openness,
    basis: packet.basis,
    sourceRanges: collectRanges(packet),
    contentHash: hashPacket(packet)
  };
  const entries = await readEntries(path);
  entries.push(record);
  await writeFile(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return record;
}

function collectRanges(packet) {
  const ranges = [];
  for (const c of packet.student.visibleClauses) {
    ranges.push({ recordId: c.recordId, range: c.sourceRange, visible: true });
  }
  for (const h of packet.student.hiddenAudit) {
    ranges.push({ recordId: h.recordId, range: h.range, visible: false, reason: h.reason });
  }
  return ranges;
}

/**
 * 查询已印练习。
 * @param {{batchId?: string, classId?: string, planId?: string, file?: string}} filter
 */
export async function queryPrints(filter = {}, options = {}) {
  const path = await logPath(options.file ?? filter.file);
  const entries = await readEntries(path);
  return entries.filter(e =>
    (!filter.batchId || e.batchId === filter.batchId) &&
    (!filter.classId || e.classId === filter.classId) &&
    (!filter.planId || e.planId === filter.planId)
  );
}

export function printEntryText(entry) {
  const lines = [];
  lines.push(`日志 ${entry.logId}｜班次 ${entry.batchId}｜班级 ${entry.classId}｜印刷时间 ${entry.printedAt}`);
  lines.push(`  计划 ${entry.planId}｜${entry.match} 第 ${entry.end} 回合第 ${entry.startShot} 投`);
  lines.push(`  当时视角：${entry.view.team ? `${entry.view.team.colour}（${entry.view.team.name}）` : '未确认'}｜${entry.view.angle}`);
  lines.push(`  后手：表定 ${entry.hammer.sheetValue} → 实际 ${entry.hammer.effectiveColour}（${entry.hammer.status}，依据 ${entry.hammer.basis}）`);
  lines.push(`  场地：${entry.direction.value}（${entry.direction.status}）｜重核：${entry.recheckRequired ? '需要' : '不需要'}｜开放性：${entry.openness.open ? '通过' : '未通过'}`);
  lines.push('  依据与来源区间：');
  for (const b of entry.basis) {
    lines.push(`    ${b.kind}｜${b.source} ${b.id}${b.range ? ` ${b.range[0]}-${b.range[1]}` : ''}｜${b.note}`);
  }
  return lines.join('\n');
}

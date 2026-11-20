#!/usr/bin/env node
/**
 * 冰壶战术备课工具命令行。
 *
 * 用法：
 *   node src/cli.js facts                        输出事实模型（JSON）
 *   node src/cli.js lesson --plan p1 [--start 4] [--json]
 *   node src/cli.js compare --plans p1,p3 [--json]
 *   node src/cli.js print --plan p1 --batch 班次1 --class 甲班 [--start 4]
 *   node src/cli.js query [--batch 班次1] [--class 甲班] [--plan p1]
 */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readMaterials } from '../materials.js';
import { buildFactModel } from './model.js';
import { buildLesson, previewText } from './lesson.js';
import { buildComparison, comparisonText } from './compare.js';
import { printEntryText, queryPrints, recordPrint } from './print-log.js';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function materialDirectory(flags) {
  return flags.materials ? pathToFileURL(resolve(flags.materials) + '/') : undefined;
}

function logFile(flags) {
  return flags.logfile ? resolve(flags.logfile) : undefined;
}

async function load(flags) {
  const tables = await readMaterials(materialDirectory(flags));
  return { tables, model: buildFactModel(tables) };
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'facts': {
      const { model } = await load(flags);
      printJson(model);
      return;
    }
    case 'lesson': {
      const { model } = await load(flags);
      const planId = flags.plan;
      if (!planId) throw new TypeError('lesson 需要 --plan 教学计划编号');
      const packet = buildLesson(model, planId, {
        startOverride: flags.start ? Number(flags.start) : undefined
      });
      if (flags.json) printJson(packet);
      else process.stdout.write(previewText(packet) + '\n');
      return;
    }
    case 'compare': {
      const { model } = await load(flags);
      const planIds = String(flags.plans ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (planIds.length !== 2) throw new TypeError('compare 需要 --plans p1,p3 两个计划编号');
      const comparison = buildComparison(model, planIds);
      if (flags.json) printJson(comparison);
      else process.stdout.write(comparisonText(comparison) + '\n');
      return;
    }
    case 'print': {
      const { model } = await load(flags);
      if (!flags.plan) throw new TypeError('print 需要 --plan 教学计划编号');
      if (!flags.batch || !flags.class) throw new TypeError('print 需要 --batch 班次编号与 --class 班级编号');
      const packet = buildLesson(model, flags.plan, {
        startOverride: flags.start ? Number(flags.start) : undefined
      });
      const record = await recordPrint(
        packet,
        { batchId: flags.batch, classId: flags.class, operator: flags.operator ?? null },
        { file: logFile(flags) }
      );
      process.stdout.write(printEntryText(record) + '\n');
      return;
    }
    case 'query': {
      const entries = await queryPrints(
        { batchId: flags.batch, classId: flags.class, planId: flags.plan },
        { file: logFile(flags) }
      );
      if (!entries.length) {
        process.stdout.write('未查询到已印练习记录。\n');
        return;
      }
      process.stdout.write(entries.map(printEntryText).join('\n\n') + '\n');
      return;
    }
    default:
      process.stderr.write('未知命令。可用：facts | lesson | compare | print | query\n');
      process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

// JSON Schema 迷你校验器：只覆盖本仓库 schema 实际用到的关键字
// （type / enum / required / pattern / minimum / maximum / anyOf / allOf-if-then / $ref）
// 目的不是通用，而是让三份 schema 每次改动都能被机器验一遍，不靠人眼。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(here, n), 'utf8'));

const typeOk = (v, t) =>
  t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
  : t === 'array' ? Array.isArray(v)
  : t === 'integer' ? Number.isInteger(v)
  : t === 'number' ? typeof v === 'number'
  : t === 'string' ? typeof v === 'string'
  : t === 'boolean' ? typeof v === 'boolean'
  : t === 'null' ? v === null : true;

function validate(schema, value, root, path = '$') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;

  if (schema.$ref) {
    const p = schema.$ref.replace(/^#\//, '').split('/');
    let s = root;
    for (const seg of p) s = s?.[seg];
    return validate(s, value, root, path);
  }
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(s, value, root, path).length === 0);
    if (!ok) errs.push(path + ' 不匹配任何 anyOf 分支');
    return errs;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(value, t))) {
      errs.push(path + ' 类型应为 ' + types.join('|') + '，实际 ' + JSON.stringify(value));
    }
  }
  if (schema.const !== undefined && value !== schema.const) {
    errs.push(path + ' 应等于常量 ' + JSON.stringify(schema.const) + '，实际 ' + JSON.stringify(value));
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(path + ' 不在枚举内：' + JSON.stringify(value));
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(path + ' 小于 minimum ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(path + ' 大于 maximum ' + schema.maximum);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(path + ' 不匹配 pattern：' + value);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(path + ' 长度不足');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(path + ' 超长');
  }
  if (schema.required && value && typeof value === 'object') {
    for (const k of schema.required) if (value[k] === undefined) errs.push(path + ' 缺必填字段 ' + k);
  }
  if (schema.properties && value && typeof value === 'object') {
    for (const [k, s] of Object.entries(schema.properties)) {
      if (value[k] !== undefined) errs.push(...validate(s, value[k], root, path + '.' + k));
    }
  }
  if (schema.allOf) {
    for (const s of schema.allOf) {
      if (s.if) {
        const cond = validate(s.if, value, root, path);
        if (cond.length === 0 && s.then) errs.push(...validate(s.then, value, root, path));
      } else {
        errs.push(...validate(s, value, root, path));
      }
    }
  }
  return errs;
}

const rule = load('rule.schema.json');
const task = load('task.schema.json');
const memo = load('memo.schema.json');
const completion = load('completion.schema.json');
const reminder = load('reminder.schema.json');

const base = { rev: 0, updated_at: 1, deleted: 0, dirty: 0 };

const cases = [
  ['rule weekly 合法', rule, { id: 'r1', title: '工作日常规', repeat_mode: 0, weekdays_mask: 31, start_date: '2026-10-19', ...base }, true],
  ['rule monthly 最后一天 合法', rule, { id: 'r2', title: '月度复盘', repeat_mode: 2, month_day: -1, start_date: '2026-10-01', ...base }, true],
  ['rule yearly 2/29 合法', rule, { id: 'r3', title: '生日', repeat_mode: 3, year_month: 2, year_day: 29, start_date: '2026-01-01', ...base }, true],
  ['rule every 3660 边界 合法', rule, { id: 'r4', title: '超长', repeat_mode: 1, repeat_every: 3660, start_date: '2026-10-01', ...base }, true],
  ['rule every 但缺 repeat_every 应失败', rule, { id: 'r5', title: 'x', repeat_mode: 1, start_date: '2026-10-01', ...base }, false],
  ['rule every=3661 越界 应失败', rule, { id: 'r6', title: 'x', repeat_mode: 1, repeat_every: 3661, start_date: '2026-10-01', ...base }, false],
  ['rule 日期非零填充 应失败', rule, { id: 'r7', title: 'x', repeat_mode: 4, start_date: '2026-1-5', ...base }, false],
  ['rule 缺 title 应失败', rule, { id: 'r8', repeat_mode: 4, start_date: '2026-10-01', ...base }, false],
  ['task 合法', task, { id: 't1', rule_id: 'r1', title: '健身', sort_order: 0, ...base }, true],
  ['task 缺 rule_id 应失败', task, { id: 't2', title: '健身', ...base }, false],
  ['memo 记事 不排期 合法', memo, { id: 'm1', kind: 0, title: '灵感碎片', start_date: null, end_date: null, ...base }, true],
  ['memo 记事 时间段 合法', memo, { id: 'm2', kind: 0, title: '项目评审', start_date: '2026-10-27', end_date: '2026-10-29', ...base }, true],
  ['memo 倒数日 合法', memo, { id: 'm3', kind: 1, title: '纪念日', start_date: '2025-10-19', ...base }, true],
  ['memo 倒数日 缺 start_date 应失败', memo, { id: 'm4', kind: 1, title: '纪念日', ...base }, false],
  ['memo 笔记本 带分类 合法', memo, { id: 'm5', kind: 2, title: '晨间流程', category: '习惯', ...base }, true],
  ['memo kind=3 越界 应失败', memo, { id: 'm6', kind: 3, title: 'x', ...base }, false],
  ['completion 合法', completion, { task_id: 't_fit', period_start: '2026-10-19', status: 1, ...base }, true],
  ['completion status=2 越界 应失败', completion, { task_id: 't1', period_start: '2026-10-19', status: 2, ...base }, false],
  ['completion 缺 period_start 应失败', completion, { task_id: 't1', status: 1, ...base }, false],
  ['completion 日期非零填充 应失败', completion, { task_id: 't1', period_start: '2026-1-5', status: 1, ...base }, false],
  ['reminder 仅通知 合法', reminder, { id: 'rm1', owner_kind: 0, owner_id: 'r1', notify_on: 1, alarm_on: 0, time_of_day: '21:00', ...base }, true],
  ['reminder 通知+闹钟 合法', reminder, { id: 'rm2', owner_kind: 0, owner_id: 'r1', notify_on: 1, alarm_on: 1, time_of_day: '09:00', snooze_min: 5, ...base }, true],
  ['reminder 两个开关都关 应失败', reminder, { id: 'rm3', owner_kind: 0, owner_id: 'r1', notify_on: 0, alarm_on: 0, time_of_day: '09:00', ...base }, false],
  ['reminder 时间格式错 应失败', reminder, { id: 'rm4', owner_kind: 0, owner_id: 'r1', notify_on: 1, alarm_on: 0, time_of_day: '9:00', ...base }, false],
  ['reminder owner_kind=3 越界 应失败', reminder, { id: 'rm5', owner_kind: 3, owner_id: 'x', notify_on: 1, alarm_on: 0, time_of_day: '09:00', ...base }, false],
];

let pass = 0;
const fails = [];
for (const [name, schema, data, shouldPass] of cases) {
  const errs = validate(schema, data, schema);
  const ok = shouldPass ? errs.length === 0 : errs.length > 0;
  if (ok) pass += 1;
  else fails.push({ name, expected: shouldPass ? '通过' : '拦下', errs });
}
console.log(JSON.stringify({ pass, total: cases.length, fails }, null, 2));
if (fails.length) process.exit(1);
'use strict';

/**
 * 逐提示岗位表（换景人员分配）。
 *
 * 规则（以全量重放结果为准）：
 *  - 仅「整组生效」的提示需要执行，才生成岗位；失败提示标记为「无需执行」；
 *  - 组内每条道具转移 = 一个同时执行的岗位；
 *  - 同一人员在同一组内最多承担一个岗位（不同组先后执行，可重复出现）；
 *  - 人员必须具备该道具的搬运资格才能承担对应岗位；
 *  - 对整组求「完整匹配」（二分图最大匹配，增广路算法），而不是按转移录入
 *    顺序贪心分配 —— 贪心会让先录入的转移占掉唯一合适的人：例如同组
 *    「屏风（张三/王五可搬）、桌子（仅张三可搬）」，必须先录的屏风改派王五，
 *    桌子才能分给张三，整组才有解；
 *  - 无法整组覆盖时：该组标记为「人手不足」，列出未覆盖道具，不输出部分岗位表。
 *
 * 人员资格或提示内容变化后，由服务端用最新数据整体重算（本模块为纯函数）。
 */

/**
 * 二分图最大匹配（Kuhn 增广路算法）：左侧为组内各条转移，右侧为人员，
 * 边表示「该人员具备这条转移所需道具的搬运资格」。
 * 与按录入顺序贪心不同：已占位的人员可被增广路改派到其他转移，
 * 从而找到整组的最大覆盖。
 *
 * @param {Array} transfers  组内转移（仅用于计数与保持顺序）
 * @param {Array<string[]>} candidates  candidates[i] = 可承担第 i 条转移的人员名单
 * @returns {Array<string|null>} 每条转移分配到的人员；null 表示该转移未被覆盖
 */
function maxMatching(transfers, candidates) {
  const assign = new Array(transfers.length).fill(null); // 转移序号 -> 人员
  const holder = new Map(); // 人员 -> 转移序号

  // 增广路：为第 ti 条转移寻找人员；若看中的人已被占，尝试把占用人改派到别的转移
  function augment(ti, seen) {
    for (const name of candidates[ti]) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (!holder.has(name) || augment(holder.get(name), seen)) {
        holder.set(name, ti);
        assign[ti] = name;
        return true;
      }
    }
    return false;
  }

  for (let ti = 0; ti < transfers.length; ti++) augment(ti, new Set());
  return assign;
}

/**
 * 生成逐提示岗位表。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string, props:string[]}>} staff 人员及其可搬运道具名单
 * @returns {Array<{number:number, note:string, status:'ok'|'understaffed'|'skipped',
 *   positions:Array<{prop:string, from:string, to:string, staff:string}>,
 *   uncovered:string[], transferCount:number}>}
 *   - ok：人员齐备，positions 为完整岗位表（每条转移一岗，同组人员不重复）；
 *   - understaffed：人手不足，positions 恒为空（不输出部分岗位表），uncovered 列出未覆盖道具；
 *   - skipped：重放未生效，无需执行，positions 恒为空。
 */
function computeAssignments(cues, results, staff) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const qualified = new Map(staff.map((s) => [s.name, new Set(s.props)]));

  return cues.map((cue) => {
    const r = resultByNumber.get(cue.number);
    const base = { number: cue.number, note: cue.note, transferCount: cue.transfers.length };

    // 失败提示：整组未生效，无需执行
    if (!r || !r.ok) {
      return { ...base, status: 'skipped', positions: [], uncovered: [] };
    }

    // 每条转移的可承担人员 = 具备该道具搬运资格的人
    const candidates = cue.transfers.map((t) =>
      staff.filter((s) => qualified.get(s.name).has(t.prop)).map((s) => s.name)
    );

    const match = maxMatching(cue.transfers, candidates);

    if (match.every((m) => m !== null)) {
      // 整组完整匹配：输出岗位表
      return {
        ...base,
        status: 'ok',
        positions: cue.transfers.map((t, i) => ({
          prop: t.prop,
          from: t.from,
          to: t.to,
          staff: match[i],
        })),
        uncovered: [],
      };
    }

    // 无解：人手不足，标出未覆盖道具，不输出部分岗位表
    return {
      ...base,
      status: 'understaffed',
      positions: [],
      uncovered: cue.transfers.filter((t, i) => match[i] === null).map((t) => t.prop),
    };
  });
}

module.exports = { computeAssignments, maxMatching };

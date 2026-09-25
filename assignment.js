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
 *  - 无法整组覆盖时：该组标记为「人手不足」，列出未覆盖道具，不输出部分岗位表，
 *    并附「资格瓶颈诊断」（见 diagnoseBottleneck）。
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
 * 资格瓶颈诊断：对「重放生效但无法整组排岗」的提示，回答「到底缺在哪、缺几人」。
 *
 * 不能只看「当前未匹配的那件道具」——最大匹配中具体哪条转移落空取决于增广
 * 顺序，是偶然表象；真正的瓶颈是一簇道具在共同争夺一小撮具备资格的人员：
 * 例如同组「屏风（张三/王五可搬）、桌子（仅张三）、椅子（仅王五）」，落空
 * 的可能显示为椅子，但瓶颈是三件道具争两个人，缺口 1 人。
 *
 * 算法（标准的霍尔缺口构造）：
 *  1. 交错搜索：从所有未匹配转移出发，转移侧沿「非匹配资格边」到人员，
 *     人员侧沿「匹配边」回到转移，得到可达集合 Z；
 *  2. Z 中的人员必然都已匹配（否则存在增广路，与最大匹配矛盾），且其匹配
 *     对象也在 Z 中，故每个连通分量内「转移数 − 人员数 = 簇内未匹配转移数 ≥ 1」；
 *  3. 把 Z 按资格边（不再区分匹配与否）拆成连通分量，每个分量就是一个
 *     互不相连的竞争簇：簇内道具只能争夺簇内这些人员，
 *     缺口人数 = 簇内岗位数 − 簇内可争人员数。
 *
 * @param {Array<{prop:string}>} transfers 组内转移（保持录入顺序）
 * @param {Array<string[]>} candidates  candidates[i] = 可承担第 i 条转移的人员名单
 * @param {Array<string|null>} match    maxMatching 的结果（转移序号 -> 人员 / null）
 * @param {string[]} staffOrder         全部人员（按录入顺序，用于簇内人员名单排序）
 * @returns {{clusters: Array<{props:string[], staff:string[], gap:number}>}}
 *   每个竞争簇：props 涉及道具（按转移录入顺序）、staff 可争人员（按人员录入顺序）、
 *   gap 缺口人数（≥1）；簇之间互不相连，按簇内首个转移的录入顺序排列。
 */
function diagnoseBottleneck(transfers, candidates, match, staffOrder) {
  const holder = new Map(); // 人员 -> 其承担的转移下标（仅已匹配）
  match.forEach((name, i) => { if (name !== null) holder.set(name, i); });

  // 1) 交错搜索：从未匹配转移出发，转移侧走非匹配边、人员侧走匹配边
  const reachT = new Set(); // 可达转移下标
  const reachS = new Set(); // 可达人员
  const queue = [];
  match.forEach((name, i) => {
    if (name === null) {
      reachT.add(i);
      queue.push({ kind: 't', i });
    }
  });
  while (queue.length) {
    const cur = queue.shift();
    if (cur.kind === 't') {
      for (const name of candidates[cur.i]) {
        if (name === match[cur.i] || reachS.has(name)) continue; // 转移侧只走非匹配边
        reachS.add(name);
        queue.push({ kind: 's', name });
      }
    } else {
      const ti = holder.get(cur.name); // 可达人员必已匹配，否则存在增广路
      if (ti === undefined || reachT.has(ti)) continue;
      reachT.add(ti);
      queue.push({ kind: 't', i: ti });
    }
  }

  // 2) 可达集合内按资格边求连通分量（先建好 人员 -> 可达转移 的反向邻接）
  const staffToTransfers = new Map();
  for (const ti of reachT) {
    for (const name of candidates[ti]) {
      if (!reachS.has(name)) continue;
      if (!staffToTransfers.has(name)) staffToTransfers.set(name, []);
      staffToTransfers.get(name).push(ti);
    }
  }

  const staffRank = new Map(staffOrder.map((name, i) => [name, i]));
  const visitedT = new Set();
  const visitedS = new Set();
  const clusters = [];

  for (const start of [...reachT].sort((a, b) => a - b)) {
    if (visitedT.has(start)) continue;
    const compT = [];
    const compS = [];
    const stack = [{ kind: 't', i: start }];
    visitedT.add(start);
    while (stack.length) {
      const cur = stack.pop();
      if (cur.kind === 't') {
        compT.push(cur.i);
        for (const name of candidates[cur.i]) {
          if (!reachS.has(name) || visitedS.has(name)) continue;
          visitedS.add(name);
          stack.push({ kind: 's', name });
        }
      } else {
        compS.push(cur.name);
        for (const ti of staffToTransfers.get(cur.name) || []) {
          if (visitedT.has(ti)) continue;
          visitedT.add(ti);
          stack.push({ kind: 't', i: ti });
        }
      }
    }
    compT.sort((a, b) => a - b);
    compS.sort((a, b) => staffRank.get(a) - staffRank.get(b));
    clusters.push({
      props: compT.map((i) => transfers[i].prop),
      staff: compS,
      gap: compT.length - compS.length, // 缺口人数 = 簇内未匹配转移数
    });
  }

  return { clusters };
}

/**
 * 生成逐提示岗位表。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string, props:string[]}>} staff 人员及其可搬运道具名单
 * @returns {Array<{number:number, note:string, status:'ok'|'understaffed'|'skipped',
 *   positions:Array<{prop:string, from:string, to:string, staff:string}>,
 *   uncovered:string[], transferCount:number,
 *   diagnosis:null|{clusters:Array<{props:string[], staff:string[], gap:number}>}>}
 *   - ok：人员齐备，positions 为完整岗位表（每条转移一岗，同组人员不重复），diagnosis 为 null；
 *   - understaffed：人手不足，positions 恒为空（不输出部分岗位表），uncovered 列出未覆盖道具，
 *     diagnosis 为资格瓶颈诊断（互不相连的竞争簇，每簇含缺口人数与道具、人员名单）；
 *   - skipped：重放未生效，无需执行，positions 恒为空，diagnosis 为 null。
 */
function computeAssignments(cues, results, staff) {
  const resultByNumber = new Map(results.map((r) => [r.number, r]));
  const qualified = new Map(staff.map((s) => [s.name, new Set(s.props)]));
  const staffOrder = staff.map((s) => s.name);

  return cues.map((cue) => {
    const r = resultByNumber.get(cue.number);
    const base = { number: cue.number, note: cue.note, transferCount: cue.transfers.length };

    // 失败提示：整组未生效，无需执行，不做瓶颈诊断
    if (!r || !r.ok) {
      return { ...base, status: 'skipped', positions: [], uncovered: [], diagnosis: null };
    }

    // 每条转移的可承担人员 = 具备该道具搬运资格的人
    const candidates = cue.transfers.map((t) =>
      staff.filter((s) => qualified.get(s.name).has(t.prop)).map((s) => s.name)
    );

    const match = maxMatching(cue.transfers, candidates);

    if (match.every((m) => m !== null)) {
      // 整组完整匹配：输出岗位表，无需瓶颈诊断
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
        diagnosis: null,
      };
    }

    // 无解：人手不足，标出未覆盖道具，不输出部分岗位表；
    // 附资格瓶颈诊断：沿资格竞争关系找出互不相连的竞争簇，而非只看未匹配道具
    return {
      ...base,
      status: 'understaffed',
      positions: [],
      uncovered: cue.transfers.filter((t, i) => match[i] === null).map((t) => t.prop),
      diagnosis: diagnoseBottleneck(cue.transfers, candidates, match, staffOrder),
    };
  });
}

module.exports = { computeAssignments, maxMatching, diagnoseBottleneck };

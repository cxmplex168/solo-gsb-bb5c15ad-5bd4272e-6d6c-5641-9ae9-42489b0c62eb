'use strict';

/* 全局状态：最近一次从服务器获取的全量数据（含重放结果） */
let state = null;
let editingCue = null; // 正在编辑的提示号，null 表示新增模式

/* ---------- 工具 ---------- */

const $ = (sel) => document.querySelector(sel);

function toast(msg, okStyle) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('ok', !!okStyle);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || '操作失败');
    throw new Error(data.error || '操作失败');
  }
  state = data; // 所有变更接口都返回最新全量状态
  render();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function locationOptions(selected) {
  return state.locations
    .map((l) => {
      const label = l.unlimited ? `${l.name}（不限）` : `${l.name}（限一件）`;
      return `<option value="${esc(l.name)}" ${l.name === selected ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}

function propOptions(selected) {
  return state.props
    .map((p) => `<option value="${esc(p.name)}" ${p.name === selected ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}

/* ---------- 冲突溯源（失败提示旁展示，lastMovedCue 为 null 表示初始区位） ---------- */

function lastMovedText(cueNumber) {
  if (cueNumber === null || cueNumber === undefined)
    return '初始区位（从未成功转移）';
  if (cueNumber === 'onsite')
    return '现场校正（断点处现场录入）';
  return `提示 ${cueNumber}`;
}

function traceHtml(trace) {
  if (!trace) return '';
  const blocks = [];

  if (trace.sourceMismatches && trace.sourceMismatches.length) {
    blocks.push(`
      <div class="trace-title">来源不符溯源</div>
      <ul>${trace.sourceMismatches
        .map((m) => `<li>「${esc(m.prop)}」当前位于「${esc(m.current)}」（最后一次成功转移：${lastMovedText(m.lastMovedCue)}），本组要求来源「${esc(m.from)}」</li>`)
        .join('')}</ul>`);
  }

  if (trace.capacityConflicts && trace.capacityConflicts.length) {
    for (const c of trace.capacityConflicts) {
      blocks.push(`
        <div class="trace-title">容量冲突溯源 · 区位「${esc(c.location)}」试算后同占道具</div>
        <ul>${c.occupants
          .map((o) => `<li>「${esc(o.prop)}」${o.movedIn
            ? '<span class="trace-tag">本组转入</span>'
            : '<span class="trace-tag dim">非本组转入</span>'}此前最后一次成功转移：${lastMovedText(o.lastMovedCue)}</li>`)
          .join('')}</ul>`);
    }
  }

  return blocks.length ? `<div class="cue-trace">${blocks.join('')}</div>` : '';
}

/* ---------- 渲染 ---------- */

function renderLocations() {
  const ul = $('#location-list');
  ul.innerHTML = state.locations
    .map((l) => `
      <li class="${l.unlimited ? 'backstage' : ''}">
        <strong>${esc(l.name)}</strong>
        <span class="cap">${l.unlimited ? '容量不限' : '限一件'}</span>
        ${l.unlimited ? '' : `<button class="link" data-del-loc="${esc(l.name)}" title="删除区位">✕</button>`}
      </li>`)
    .join('');
  $('#prop-location').innerHTML = locationOptions();
}

function renderProps() {
  const tbody = $('#prop-rows');
  tbody.innerHTML = state.props
    .map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td><select data-prop-loc="${esc(p.name)}">${locationOptions(p.location)}</select></td>
        <td><button class="link" data-del-prop="${esc(p.name)}">删除</button></td>
      </tr>`)
    .join('');
}

function renderCueForm() {
  $('#cue-number').disabled = editingCue !== null;
  $('#cue-submit').textContent = editingCue !== null ? `保存修改（提示号 ${editingCue}）` : '保存提示';
  $('#cue-cancel').classList.toggle('hidden', editingCue === null);
}

function addTransferRow(t) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="t-prop">${propOptions(t && t.prop)}</select></td>
    <td><select class="t-from">${locationOptions(t && t.from)}</select></td>
    <td><select class="t-to">${locationOptions(t && t.to)}</select></td>
    <td><button type="button" class="link t-remove">移除</button></td>`;
  tr.querySelector('.t-remove').onclick = () => {
    tr.remove();
    if (!$('#transfer-rows').children.length) addTransferRow();
    clearPreview();
  };
  $('#transfer-rows').appendChild(tr);
}

function resetCueForm() {
  editingCue = null;
  $('#cue-number').value = '';
  $('#cue-note').value = '';
  $('#transfer-rows').innerHTML = '';
  addTransferRow();
  renderCueForm();
  clearPreview();
}

function renderCues() {
  const box = $('#cue-list');
  if (!state.cues.length) {
    box.innerHTML = '<p class="hint">还没有提示，请在上方录入。</p>';
    return;
  }
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  box.innerHTML = state.cues
    .map((c) => {
      const r = resultByNumber.get(c.number);
      const badge = r && r.ok
        ? '<span class="badge ok">✓ 已生效</span>'
        : '<span class="badge fail">✗ 整组未生效</span>';
      const transfers = c.transfers
        .map((t) => `<div>「${esc(t.prop)}」 ${esc(t.from)} <span class="arrow">→</span> ${esc(t.to)}</div>`)
        .join('');
      const errors = r && !r.ok
        ? `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${traceHtml(r.trace)}`
        : '';
      return `
        <div class="cue-item ${r && r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${c.number}</span>
            <span class="note">${esc(c.note || '')}</span>
            ${badge}
          </div>
          <div class="cue-transfers">${transfers}</div>
          ${errors}
          <div class="cue-actions">
            <button class="small ghost" data-edit-cue="${c.number}">编辑</button>
            <button class="small danger" data-del-cue="${c.number}">删除</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderReplay() {
  const box = $('#replay-results');
  if (!state.replay.results.length) {
    box.innerHTML = '<p class="hint">暂无提示可重放。</p>';
  } else {
    box.innerHTML = state.replay.results
      .map((r) => `
        <div class="cue-item ${r.ok ? 'ok' : 'fail'}">
          <div class="cue-head">
            <span class="num">提示 ${r.number}</span>
            <span class="note">${esc(r.note || '')}</span>
            ${r.ok ? '<span class="badge ok">✓ 整组生效</span>' : '<span class="badge fail">✗ 整组未生效</span>'}
          </div>
          ${r.ok ? '' : `<ul class="cue-errors">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${traceHtml(r.trace)}`}
        </div>`)
      .join('');
  }

  $('#final-board').innerHTML = Object.entries(state.replay.finalLocations)
    .map(([loc, props]) => `
      <div class="loc ${loc === '后台' ? 'backstage' : ''}">
        <div class="loc-name">${esc(loc)}</div>
        ${props.length ? props.map((p) => `<span class="chip">${esc(p)}</span>`).join('') : '<span class="empty">（空）</span>'}
      </div>`)
    .join('');
}

function render() {
  renderLocations();
  renderProps();
  renderCueForm();
  renderCues();
  renderReplay();
  renderSimForm();
  renderStaff();
  renderAssignments();
}

/* ---------- 换景人员与逐提示岗位表 ---------- */

function renderStaff() {
  const box = $('#staff-list');
  if (!state.staff.length) {
    box.innerHTML = '<p class="hint">还没有人员，请在下方添加并授予搬运资格。</p>';
    return;
  }
  box.innerHTML = state.staff
    .map((s) => {
      const chips = s.props
        .map((p) => `
          <span class="chip qual-chip">${esc(p)}
            <button type="button" class="chip-x" data-del-qual="${esc(s.name)}" data-prop="${esc(p)}" title="移除该道具的搬运资格">✕</button>
          </span>`)
        .join('');
      // 只能授予尚未具备的道具资格
      const available = state.props.filter((p) => !s.props.includes(p.name));
      const addForm = available.length
        ? `<form class="qual-form inline-form" data-staff="${esc(s.name)}">
             <select class="qual-prop">${available
               .map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`)
               .join('')}</select>
             <button type="submit" class="small ghost">＋ 授予资格</button>
           </form>`
        : '<p class="hint">已具备全部道具的搬运资格。</p>';
      return `
        <div class="staff-item">
          <div class="staff-head">
            <strong>${esc(s.name)}</strong>
            ${s.props.length ? '' : '<span class="hint">（暂无搬运资格，无法承担岗位）</span>'}
            <button type="button" class="link" data-del-staff="${esc(s.name)}">删除</button>
          </div>
          <div class="staff-quals">${chips}</div>
          ${addForm}
        </div>`;
    })
    .join('');
}

/* ---------- 资格瓶颈诊断（人手不足组：竞争簇、每簇缺口与道具/人员名单） ---------- */

function diagnosisHtml(diagnosis) {
  if (!diagnosis || !diagnosis.clusters || !diagnosis.clusters.length) return '';
  const clusters = diagnosis.clusters
    .map((c, ci) => {
      const uncoveredSet = new Set(c.uncoveredProps);
      const propChips = c.props
        .map((p) => {
          const miss = uncoveredSet.has(p);
          return `<span class="bn-prop${miss ? ' miss' : ''}">${esc(p)}${miss ? '<span class="trace-tag">未匹配</span>' : ''}</span>`;
        })
        .join('');
      const staffText = c.staff.length
        ? c.staff.map((s) => `「${esc(s)}」`).join('、')
        : '<em>无任何具备资格的人员</em>';
      return `
        <div class="bn-cluster">
          <div class="bn-cluster-head">竞争簇 ${ci + 1}：<strong>缺 ${c.shortage} 人</strong>
            <span class="hint">（簇内 ${c.props.length} 件道具争夺 ${c.staff.length} 名合格人员，最多只能排开 ${c.props.length - c.shortage} 个岗位）</span>
          </div>
          <div class="bn-line"><span class="bn-label">竞争道具</span>${propChips}</div>
          <div class="bn-line"><span class="bn-label">合格人员</span>${staffText}</div>
        </div>`;
    })
    .join('');
  return `
    <div class="bottleneck">
      <div class="bn-title">🔍 资格瓶颈诊断 · 共缺 ${diagnosis.shortage} 人，${diagnosis.clusters.length} 个互不相通的竞争簇</div>
      <p class="bn-intro hint">下列簇内道具只能由簇内人员搬运且道具多于人员，与簇外人员/资格无关；为簇内任一道具新增可搬人员（或为现有人员补授资格）即可缓解对应缺口。簇内已匹配的道具同样是瓶颈的一部分，不能只看当前未匹配道具。</p>
      ${clusters}
    </div>`;
}

function renderAssignments() {
  const list = state.assignments || [];
  const count = { ok: 0, understaffed: 0, skipped: 0 };
  for (const a of list) count[a.status]++;

  $('#assignment-summary').innerHTML = list.length
    ? `共 ${list.length} 组提示：<span class="sum-ok">${count.ok} 组人员齐备</span> · ` +
      `<span class="sum-lack">${count.understaffed} 组人手不足</span> · ` +
      `<span class="sum-skip">${count.skipped} 组无需执行</span>`
    : '暂无提示可排岗。';

  $('#assignment-list').innerHTML = list
    .map((a) => {
      if (a.status === 'skipped') {
        // 重放未生效：无需执行，不排岗
        return `
          <div class="cue-item skip">
            <div class="cue-head">
              <span class="num">提示 ${a.number}</span>
              <span class="note">${esc(a.note || '')}</span>
              <span class="badge skip">— 无需执行（整组未生效）</span>
            </div>
          </div>`;
      }
      if (a.status === 'understaffed') {
        // 整组无法完整匹配：标出未覆盖道具，不输出部分岗位表；附资格瓶颈诊断
        return `
          <div class="cue-item fail">
            <div class="cue-head">
              <span class="num">提示 ${a.number}</span>
              <span class="note">${esc(a.note || '')}</span>
              <span class="badge fail">✗ 人手不足</span>
            </div>
            <ul class="cue-errors">
              <li>本组需 ${a.transferCount} 个同时执行的岗位，现有资格人员无法整组覆盖；未覆盖道具：${a.uncovered.map((p) => `「${esc(p)}」`).join('、')}</li>
            </ul>
            ${diagnosisHtml(a.diagnosis)}
            <p class="hint">不输出部分岗位表 —— 请在 ⑦ 中补充人员或调整搬运资格，岗位表与瓶颈诊断将自动重算。</p>
          </div>`;
      }
      const rows = a.positions
        .map((p, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${esc(p.prop)}</td>
            <td>${esc(p.from)} <span class="arrow">→</span> ${esc(p.to)}</td>
            <td><strong>${esc(p.staff)}</strong></td>
          </tr>`)
        .join('');
      return `
        <div class="cue-item ok">
          <div class="cue-head">
            <span class="num">提示 ${a.number}</span>
            <span class="note">${esc(a.note || '')}</span>
            <span class="badge ok">✓ 人员齐备（${a.positions.length} 岗）</span>
          </div>
          <table class="table assign-table">
            <thead><tr><th>岗位</th><th>道具</th><th>转移</th><th>担当</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    })
    .join('');
}

/* ---------- 事件 ---------- */

$('#location-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#location-name').value.trim();
  if (!name) return;
  api('/api/locations', 'POST', { name }).then(() => { $('#location-name').value = ''; }).catch(() => {});
});

$('#location-list').addEventListener('click', (e) => {
  const name = e.target.dataset.delLoc;
  if (!name) return;
  if (confirm(`删除区位「${name}」？`)) api(`/api/locations/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#prop-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#prop-name').value.trim();
  const location = $('#prop-location').value;
  if (!name) return;
  api('/api/props', 'POST', { name, location }).then(() => { $('#prop-name').value = ''; }).catch(() => {});
});

$('#prop-rows').addEventListener('change', (e) => {
  const name = e.target.dataset.propLoc;
  if (!name) return;
  api(`/api/props/${encodeURIComponent(name)}`, 'PUT', { location: e.target.value }).catch(() => {});
});

$('#prop-rows').addEventListener('click', (e) => {
  const name = e.target.dataset.delProp;
  if (!name) return;
  if (confirm(`删除道具「${name}」？引用它的提示在重放时会报错。`))
    api(`/api/props/${encodeURIComponent(name)}`, 'DELETE').catch(() => {});
});

$('#add-transfer').addEventListener('click', () => { addTransferRow(); clearPreview(); });

$('#cue-cancel').addEventListener('click', resetCueForm);

/* ---------- 试排预览（不写库） ---------- */

function collectCueForm() {
  return {
    number: Number($('#cue-number').value),
    note: $('#cue-note').value.trim(),
    transfers: [...$('#transfer-rows').querySelectorAll('tr')].map((tr) => ({
      prop: tr.querySelector('.t-prop').value,
      from: tr.querySelector('.t-from').value,
      to: tr.querySelector('.t-to').value,
    })),
  };
}

function clearPreview() {
  const panel = $('#cue-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function statusSideHtml(side) {
  if (!side) return '<span class="pv-none">（序列中不存在）</span>';
  if (side.ok) return '<span class="badge ok">✓ 生效</span>';
  return `<span class="badge fail">✗ 未生效</span>
    <ul class="cue-errors">${side.errors.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无冲突原因）</li>'}</ul>`;
}

function renderPreview(data) {
  const panel = $('#cue-preview-panel');
  const modeText = data.mode === 'replace'
    ? `假设<strong>替换</strong>提示 ${data.draft.number} 的整组内容`
    : `假设<strong>新增</strong>提示 ${data.draft.number}`;

  const cueBlocks = data.changedCues
    .map((c) => {
      const flip = !c.before || !c.after
        ? '<span class="pv-tag new">序列成员变化</span>'
        : c.after.ok
          ? '<span class="pv-flip up">未生效 → 生效 ↑</span>'
          : '<span class="pv-flip down">生效 → 未生效 ↓</span>';
      return `
        <div class="pv-cue">
          <div class="pv-cue-head"><span class="num">提示 ${c.number}</span> ${flip}</div>
          <div class="pv-sides">
            <div class="pv-side"><div class="pv-side-label">现行</div>${statusSideHtml(c.before)}</div>
            <div class="pv-arrow">→</div>
            <div class="pv-side"><div class="pv-side-label">假设</div>${statusSideHtml(c.after)}</div>
          </div>
        </div>`;
    })
    .join('');

  const movedBlocks = data.movedProps.length
    ? `<ul class="pv-moved">${data.movedProps
        .map((m) => `<li>「${esc(m.prop)}」：${m.from ? esc(m.from) : '（不存在）'} <span class="arrow">→</span> ${m.to ? esc(m.to) : '（不存在）'}</li>`)
        .join('')}</ul>`
    : '<p class="hint">没有道具的最终区位发生变化。</p>';

  panel.innerHTML = `
    <div class="pv-title">🧪 试排预览 · ${modeText}（仅内存重放，未写入数据库）</div>
    <h4>生效状态发生变化的提示</h4>
    ${cueBlocks || '<p class="hint">草稿加入后，所有提示的生效状态均无变化。</p>'}
    <h4>最终区位发生变化的道具</h4>
    ${movedBlocks}`;
  panel.classList.remove('hidden');
}

function renderPreviewError(msg) {
  const panel = $('#cue-preview-panel');
  panel.innerHTML = `<div class="pv-title">🧪 试排预览</div><div class="pv-error">草稿不合法：${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#cue-preview').addEventListener('click', async () => {
  const btn = $('#cue-preview');
  clearPreview();
  btn.disabled = true;
  btn.textContent = '重放中…';
  try {
    const res = await fetch('/api/cues/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectCueForm()),
    });
    const data = await res.json();
    if (!res.ok) {
      renderPreviewError(data.error || '预览失败');
    } else {
      renderPreview(data);
    }
  } catch (err) {
    renderPreviewError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🧪 试排预览（不保存）';
  }
});

// 表单内容一旦改动，旧预览即失效
$('#cue-form').addEventListener('input', clearPreview);
$('#cue-form').addEventListener('change', clearPreview);

$('#cue-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const { number, note, transfers } = collectCueForm();
  const req = editingCue !== null
    ? api(`/api/cues/${editingCue}`, 'PUT', { note, transfers })
    : api('/api/cues', 'POST', { number, note, transfers });
  req.then(resetCueForm).catch(() => {});
});

$('#cue-list').addEventListener('click', (e) => {
  const editNum = e.target.dataset.editCue;
  const delNum = e.target.dataset.delCue;
  if (editNum) {
    const cue = state.cues.find((c) => c.number === Number(editNum));
    if (!cue) return;
    editingCue = cue.number;
    $('#cue-number').value = cue.number;
    $('#cue-note').value = cue.note || '';
    $('#transfer-rows').innerHTML = '';
    cue.transfers.forEach((t) => addTransferRow(t));
    renderCueForm();
    clearPreview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (delNum) {
    if (confirm(`删除提示 ${delNum}？删除后将按提示号重放全部剩余提示。`))
      api(`/api/cues/${delNum}`, 'DELETE').catch(() => {});
  }
});

/* ---------- 批量平移提示号 ---------- */

let shiftPlan = null; // 最近一次预览返回的方案（含冲突信息），输入一变即失效

function collectShiftForm() {
  return {
    from: Number($('#shift-from').value),
    to: Number($('#shift-to').value),
    shift: Number($('#shift-delta').value),
  };
}

function clearShiftPreview() {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderShiftPlan(data) {
  shiftPlan = data;
  const conflictSet = new Set(data.conflicts || []);
  const rows = data.moves
    .map((m) => {
      const hit = conflictSet.has(m.to);
      return `<li class="${hit ? 'shift-hit' : ''}">
        <span class="num">${m.from}</span> <span class="arrow">→</span> <span class="num">${m.to}</span>
        <span class="shift-note">${esc(m.note || '')}</span>
        ${hit ? '<span class="badge fail">冲突</span>' : ''}
      </li>`;
    })
    .join('');
  const summary = conflictSet.size
    ? `<div class="pv-error">新号 ${[...conflictSet].join('、')} 与区间外已有提示冲突，整批不可执行。</div>`
    : `<p class="hint">共 ${data.moves.length} 条提示，校验通过，可执行平移。</p>`;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `
    <div class="pv-title">⇄ 平移预览：闭区间每条提示的原号 → 新号（尚未写入数据库）</div>
    <ul class="shift-list">${rows}</ul>
    ${summary}`;
  panel.classList.remove('hidden');
  $('#shift-apply').disabled = conflictSet.size > 0;
}

function renderShiftError(msg) {
  shiftPlan = null;
  $('#shift-apply').disabled = true;
  const panel = $('#shift-preview-panel');
  panel.innerHTML = `<div class="pv-title">⇄ 批量平移提示号</div><div class="pv-error">${esc(msg)}</div>`;
  panel.classList.remove('hidden');
}

$('#shift-preview').addEventListener('click', async () => {
  const btn = $('#shift-preview');
  clearShiftPreview();
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectShiftForm()),
    });
    const data = await res.json();
    if (!res.ok) renderShiftError(data.error || '预览失败');
    else renderShiftPlan(data);
  } catch (err) {
    renderShiftError('无法连接服务器');
  } finally {
    btn.disabled = false;
  }
});

// 输入一旦改动，旧预览即失效，须重新预览
$('#shift-form').addEventListener('input', clearShiftPreview);

$('#shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!shiftPlan || (shiftPlan.conflicts || []).length) return;
  const body = collectShiftForm();
  if (!confirm(`确认将区间 [${body.from}, ${body.to}] 内的 ${shiftPlan.moves.length} 条提示平移 ${body.shift > 0 ? '+' : ''}${body.shift}？`))
    return;
  const btn = $('#shift-apply');
  btn.disabled = true;
  try {
    const res = await fetch('/api/cues/shift', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // 执行时校验失败（如预览后数据变化）：整批拒绝，标出冲突号
      if (data.moves) renderShiftPlan(data);
      else renderShiftError(data.error || '平移被拒绝');
      toast(data.error || '平移被拒绝');
      return;
    }
    state = data; // 成功：服务端已按新号全量重放，刷新整个页面
    render();
    clearShiftPreview();
    resetCueForm(); // 编辑中的提示号可能已被平移，退出编辑态避免指向旧号
    $('#shift-from').value = $('#shift-to').value = $('#shift-delta').value = '';
    toast('平移完成，已按新号全量重放', true);
  } catch (err) {
    renderShiftError('无法连接服务器');
  }
});

/* ---------- 现场偏差推演（不写库） ---------- */

let simBreakpoint = '';      // 选中的断点提示号
let simOverrides = {};       // 道具 -> 现场区位（'' 或缺失 = 沿用计划）
let simResult = null;        // 最近一次成功推演的结果，全局状态一变即失效

function clearSimResult() {
  simResult = null;
  const panel = $('#sim-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function renderSimForm(keepResult) {
  if (!keepResult) clearSimResult();

  // 道具被删除后，清理残留的现场录入
  for (const prop of Object.keys(simOverrides)) {
    if (!state.props.some((p) => p.name === prop)) delete simOverrides[prop];
  }

  // 断点下拉：复用重放结果标注该提示在计划序列中的生效情况
  const sel = $('#sim-breakpoint');
  const resultByNumber = new Map(state.replay.results.map((r) => [r.number, r]));
  const opts = ['<option value="">请选择断点提示号…</option>']
    .concat(state.cues.map((c) => {
      const r = resultByNumber.get(c.number);
      const label = r
        ? `${c.number}（${r.ok ? '已生效' : '未生效'}）${c.note ? ' · ' + c.note : ''}`
        : `${c.number}`;
      return `<option value="${c.number}" ${String(c.number) === String(simBreakpoint) ? 'selected' : ''}>${esc(label)}</option>`;
    }));
  sel.innerHTML = opts.join('');
  if (!state.cues.some((c) => String(c.number) === String(simBreakpoint)))
    simBreakpoint = '';
  sel.value = simBreakpoint;

  // 道具行：断点处计划区位（推演成功后才有值）+ 现场区位录入
  const planState = simResult ? simResult.planStateAtBreakpoint : null;
  $('#sim-rows').innerHTML = state.props
    .map((p) => {
      const planLoc = planState ? planState[p.name] : null;
      const val = Object.prototype.hasOwnProperty.call(simOverrides, p.name)
        ? simOverrides[p.name]
        : '';
      return `
        <tr data-sim-prop="${esc(p.name)}">
          <td>${esc(p.name)}</td>
          <td class="sim-plan-loc">${planLoc !== null ? esc(planLoc) : '<span class="empty">—</span>'}</td>
          <td>
            <select class="sim-loc">
              <option value="" ${val === '' ? 'selected' : ''}>沿用计划</option>
              ${locationOptions(val === '' ? null : val)}
            </select>
          </td>
        </tr>`;
    })
    .join('');
}

function simStatusHtml(side) {
  if (!side) return '<span class="pv-none">（序列中不存在）</span>';
  if (side.ok) return '<span class="badge ok">✓ 生效</span>';
  return `<span class="badge fail">✗ 整组未生效</span>
    <ul class="cue-errors">${side.errors.map((e) => `<li>${esc(e)}</li>`).join('') || '<li>（无冲突原因）</li>'}</ul>
    ${traceHtml(side.trace)}`;
}

function renderSimPanel(data) {
  const panel = $('#sim-panel');

  // 一、断点处计划 / 现场差异
  const breakRows = data.breakpointDiff.length
    ? data.breakpointDiff
        .map((d) => `
          <tr class="sim-diff-row">
            <td>${esc(d.prop)}${d.recorded ? ' <span class="trace-tag">现场录入</span>' : ''}</td>
            <td>${esc(d.plan)}</td>
            <td><span class="arrow">→</span></td>
            <td>${esc(d.onsite)}</td>
          </tr>`)
        .join('')
    : '<tr><td colspan="4" class="hint" style="border:none">所有道具均沿用断点处计划区位，无差异。</td></tr>';

  // 二、后续各提示：原计划 vs 现场推演
  const cueBlocks = data.followCues.length
    ? data.followCues.map((c) => {
        const flip = c.changed
          ? c.onsite.ok
            ? '<span class="pv-flip up">未生效 → 生效 ↑</span>'
            : '<span class="pv-flip down">生效 → 未生效 ↓</span>'
          : '<span class="pv-tag">生效状态不变</span>';
        return `
          <div class="pv-cue">
            <div class="pv-cue-head"><span class="num">提示 ${c.number}</span><span class="note">${esc(c.note || '')}</span>${flip}</div>
            <div class="pv-sides">
              <div class="pv-side"><div class="pv-side-label">原计划</div>${simStatusHtml(c.plan)}</div>
              <div class="pv-arrow">→</div>
              <div class="pv-side"><div class="pv-side-label">现场推演</div>${simStatusHtml(c.onsite)}</div>
            </div>
          </div>`;
      }).join('')
    : '<p class="hint">断点之后没有后续提示。</p>';

  // 三、最终道具区位差异
  const finalBlocks = data.finalDiff.length
    ? `<ul class="pv-moved">${data.finalDiff
        .map((d) => `<li>「${esc(d.prop)}」：${esc(d.plan)} <span class="arrow">→</span> ${esc(d.onsite)}${d.fromBreakpoint ? '<span class="trace-tag dim">停留在断点现场区位</span>' : ''}</li>`)
        .join('')}</ul>`
    : '<p class="hint">推演结束后，所有道具的最终区位与原计划一致。</p>';

  panel.innerHTML = `
    <div class="pv-title">🎯 现场偏差推演 · 断点为提示 ${data.breakpoint}（${esc(data.note || '无备注')}）—— 仅内存重放，未写入数据库</div>
    <h4>一、断点处计划 / 现场区位差异（另有 ${data.unchangedAtBreakpoint} 件道具无差异、沿用计划）</h4>
    <table class="table sim-diff-table">
      <thead><tr><th>道具</th><th>计划区位</th><th></th><th>现场区位</th></tr></thead>
      <tbody>${breakRows}</tbody>
    </table>
    <h4>二、断点之后各提示的生效状态（原计划 → 现场推演，失败组仍整组不生效）</h4>
    ${cueBlocks}
    <h4>三、推演结束后的最终道具区位差异（原计划 → 现场推演）</h4>
    ${finalBlocks}`;
  panel.classList.remove('hidden');
}

function renderSimError(msg, data) {
  const panel = $('#sim-panel');
  const conflicts = data && data.validation && data.validation.conflicts
    ? `<ul class="cue-errors">${data.validation.conflicts.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
    : '';

  // 现场区位不合法时，仍把已解析出的计划/现场区位并列展示，便于对照修改
  let breakTable = '';
  if (data && data.planState && data.onsiteState) {
    const rows = state.props
      .map((p) => {
        const plan = data.planState[p.name];
        const onsite = data.onsiteState[p.name];
        const diff = plan !== onsite;
        return `
          <tr class="${diff ? 'sim-diff-row' : ''}">
            <td>${esc(p.name)}</td>
            <td>${esc(plan)}</td>
            <td><span class="arrow">→</span></td>
            <td>${esc(onsite)}</td>
          </tr>`;
      })
      .join('');
    breakTable = `
      <h4>断点处计划 / 现场区位对照</h4>
      <table class="table sim-diff-table">
        <thead><tr><th>道具</th><th>计划区位</th><th></th><th>现场区位</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  panel.innerHTML = `
    <div class="pv-title">🎯 现场偏差推演 · 断点 ${data && data.breakpoint ? data.breakpoint : ''}</div>
    <div class="pv-error">${esc(msg)}</div>
    ${conflicts}
    ${breakTable}`;
  panel.classList.remove('hidden');
}

// 记录现场区位录入；录入一变，旧推演即失效
$('#sim-rows').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-sim-prop]');
  if (!row || !e.target.classList.contains('sim-loc')) return;
  simOverrides[row.dataset.simProp] = e.target.value;
  clearSimResult();
});

// 切换断点：计划区位列与旧推演都失效，保留已录入的现场区位
$('#sim-breakpoint').addEventListener('change', (e) => {
  simBreakpoint = e.target.value;
  renderSimForm();
});

$('#sim-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!simBreakpoint) {
    renderSimError('请先选择一个已执行完的提示号作为断点');
    return;
  }
  const overrides = Object.entries(simOverrides)
    .filter(([, loc]) => loc !== '')
    .map(([prop, location]) => ({ prop, location }));

  const btn = $('#sim-run');
  btn.disabled = true;
  btn.textContent = '推演中…';
  try {
    const res = await fetch('/api/onsite/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakpoint: Number(simBreakpoint), overrides }),
    });
    const data = await res.json();
    if (!res.ok) {
      renderSimError(data.error || '推演无法进行', data);
    } else {
      simResult = data;
      renderSimForm(true);
      renderSimPanel(data);
    }
  } catch (err) {
    renderSimError('无法连接服务器');
  } finally {
    btn.disabled = false;
    btn.textContent = '🎯 开始现场推演';
  }
});

/* ---------- 换景人员维护 ---------- */

$('#staff-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#staff-name').value.trim();
  if (!name) return;
  api('/api/staff', 'POST', { name }).then(() => { $('#staff-name').value = ''; }).catch(() => {});
});

$('#staff-list').addEventListener('click', (e) => {
  const delStaff = e.target.dataset.delStaff;
  if (delStaff) {
    if (confirm(`删除人员「${delStaff}」？其搬运资格将一并删除，岗位表随即按最新数据重算。`))
      api(`/api/staff/${encodeURIComponent(delStaff)}`, 'DELETE').catch(() => {});
    return;
  }
  const delQual = e.target.dataset.delQual;
  if (delQual) {
    const prop = e.target.dataset.prop;
    api(`/api/staff/${encodeURIComponent(delQual)}/quals/${encodeURIComponent(prop)}`, 'DELETE').catch(() => {});
  }
});

// 每个人员卡片内的「授予资格」小表单（submit 事件会冒泡到列表容器）
$('#staff-list').addEventListener('submit', (e) => {
  const form = e.target.closest('.qual-form');
  if (!form) return;
  e.preventDefault();
  const staff = form.dataset.staff;
  const prop = form.querySelector('.qual-prop').value;
  api(`/api/staff/${encodeURIComponent(staff)}/quals`, 'POST', { prop }).catch(() => {});
});

/* ---------- 启动 ---------- */

api('/api/state').then(resetCueForm).catch(() => toast('无法连接服务器'));

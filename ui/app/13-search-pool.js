'use strict';

function bindSearchPoolButton(button) {
  const badge = $('#search-pool-mode-hint');
  const note = $('#search-provider-mode-note');
  const label = $('#search-provider-label');
  const toggle = $('#cfg-websearch');
  let latest;
  function describe(pool) {
    latest = pool;
    const keys = pool.keys.filter((key) => pool.chain.includes(key.provider));
    const ready = keys.some((key) => key.status === 'ready');
    let mode = pool.enabled ? '搜索池' : '单服务';
    if (pool.enabled && !ready) mode = keys.length ? '无可用凭据' : '搜索池待配置';
    badge.textContent = toggle.checked ? mode : '已关闭';
    badge.classList.toggle('ok', toggle.checked && pool.enabled && ready);
    badge.classList.toggle('warn', toggle.checked && pool.enabled && !ready);
    note.hidden = !pool.enabled;
    label.textContent = pool.enabled ? '编辑服务配置' : '搜索提供方';
  }
  toggle.addEventListener('change', () => { if (latest) describe(latest); });
  button.addEventListener('searchpoolchange', (event) => describe(event.detail));
  api('/api/search-pool').then(({pool}) => {
    if (!latest && button.isConnected) describe(pool);
  }).catch(() => { if (!latest) badge.textContent = '状态未加载'; });
  button.addEventListener('click', () => {
    // 弹窗打开期间设置页可能已经重绘，将结果交给当前页的卡片。
    openSearchPool((pool) => $('#manage-search-pool')?.dispatchEvent(new CustomEvent('searchpoolchange', { detail: pool })));
  });
}

function openSearchPool(onUpdate) {
  const modal = modelModalShell({
    head: '管理搜索池',
    body: '<div id="pool-content"></div>',
    foot: `<div class="hint pool-footer-status" id="pool-status" role="status"></div>
      <button type="button" class="btn btn-small btn-ghost" id="pool-refresh">刷新状态</button>`
  });
  modal.classList.add('pool-manager-overlay');
  const content = modal.querySelector('#pool-content');
  const status = modal.querySelector('#pool-status');
  const refresh = modal.querySelector('#pool-refresh');
  let data;
  let busy = false;

  // 所有写操作串行，并以服务端返回的用量和状态重新渲染。失败时保留编辑内容。
  async function request(command) {
    if (busy) return false;
    const previousFocus = document.activeElement;
    const focusInside = content.contains(previousFocus);
    const keyRow = focusInside && previousFocus.closest('[data-key-id]');
    const routeRow = focusInside && previousFocus.closest('[data-provider]');
    busy = true;
    content.inert = true;
    refresh.disabled = true;
    status.textContent = command ? '正在保存…' : '正在加载…';
    try {
      data = await api('/api/search-pool', command
        ? {method: 'POST', body: JSON.stringify(command)}
        : {});
      onUpdate(data.pool);
      if (modal.isConnected) render(command);
      status.textContent = command ? '已保存' : '';
      return true;
    } catch (error) {
      status.textContent = `${command ? '保存' : '加载'}失败：${error.message}`;
      return false;
    } finally {
      busy = false;
      content.inert = false;
      refresh.disabled = false;
      if (modal.isConnected && focusInside && !previousFocus.isConnected) {
        let target;
        if (keyRow) {
          const row = [...content.querySelectorAll('[data-key-id]')].find((el) => el.dataset.keyId === keyRow.dataset.keyId);
          target = row?.querySelector('summary') || content.querySelector('[data-key="add"]');
        } else if (routeRow) {
          const row = [...content.querySelectorAll('[data-provider]')].find((el) => el.dataset.provider === routeRow.dataset.provider);
          target = row?.querySelector('button:not(:disabled)') || content.querySelector('#pool-new-provider');
        }
        (target || content.querySelector('#pool-mode'))?.focus({preventScroll: true});
      }
    }
  }

  function render(command) {
    const {pool, providers} = data;
    const previous = content.querySelector('#pool-config');
    // 服务顺序和凭据独立保存；重绘时保留尚未提交的模式和阈值。
    const savedStrategy = command?.action === 'configure' && command.enabled !== undefined;
    const draft = previous?.dataset.modified && !savedStrategy
      ? { mode: previous.elements.mode.value, threshold: previous.elements.threshold.value }
      : null;
    const names = new Map(providers.map((p) => [p.id, p.name]));
    const remaining = providers.filter((p) => !pool.chain.includes(p.id));
    const statuses = { ready: '可用', disabled: '已停用', exhausted: '额度已用完', failed: '失败停用' };
    const periods = { day: '本日', month: '本月', total: '累计' };
    const chainRows = pool.chain.map((id, index) => {
      const name = esc(names.get(id) || id);
      return `<li class="pool-route-row" data-provider="${esc(id)}">
        <span class="pool-route-rank" aria-hidden="true">${index + 1}</span>
        <span class="pool-route-name">${name}</span>
        <div class="pool-route-actions">
          <button type="button" class="btn btn-small btn-ghost" data-chain="up" aria-label="上移${name}" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-small btn-ghost" data-chain="down" aria-label="下移${name}" title="下移" ${index === pool.chain.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn-small btn-ghost" data-chain="remove" aria-label="将${name}移出顺序">移出</button>
        </div>
      </li>`;
    }).join('');
    const keys = pool.keys.map((key) => {
      const changed = key.endpointChanged || key.status === 'endpointChanged';
      const blocked = changed || key.duplicateDefault;
      const service = names.get(key.provider) || key.provider;
      const kind = key.hasApiKey ? '专用密钥' : '服务默认凭据';
      let state = statuses[key.status] || key.status;
      let note = '';
      if (changed) {
        state = '需重新绑定';
        note = '服务端点已变更，请编辑凭据重新绑定。';
      } else if (key.duplicateDefault) {
        state = '已跳过';
        note = '默认凭据与池中专用密钥相同。';
      }
      const tones = {ready: 'ok', exhausted: 'warn', failed: 'err'};
      const tone = blocked ? 'warn' : tones[key.status] || '';
      return `<li class="pool-key-row" data-key-id="${esc(key.id)}">
        <div class="pool-key-main">
          <div class="pool-key-title"><strong>${esc(key.label || service)}</strong><span class="badge ${tone}">${esc(state)}</span></div>
          <div class="pool-key-meta">${esc(key.label ? `${service} · ${kind}` : kind)}${key.failures ? ` · 连续失败 ${esc(key.failures)} 次` : ''}</div>
          ${note ? `<div class="pool-key-note hint">${esc(note)}</div>` : ''}
        </div>
        <div class="pool-usage">
          <span>${esc(periods[key.period] || key.period)}已用 ${esc(key.used)} / ${key.quota ? esc(key.quota) : '不限'} 次</span>
          ${key.quota ? `<progress aria-label="${esc(service)}额度使用量" max="${esc(key.quota)}" value="${esc(key.used)}"></progress>` : ''}
        </div>
        <button type="button" class="btn btn-small pool-key-edit" data-key="edit">编辑</button>
        <details class="pool-key-more">
          <summary class="btn btn-small btn-ghost" aria-label="${esc(key.label || service)}的更多操作" title="更多操作">⋯</summary>
          <div class="pool-more-actions">
            <button type="button" class="btn btn-small btn-ghost" data-key="toggle" ${blocked ? 'disabled' : ''}>${key.enabled ? '停用' : '启用'}</button>
            <button type="button" class="btn btn-small btn-ghost" data-key="reset" ${blocked || (!key.failures && key.status !== 'failed') ? 'disabled' : ''}>清除失败状态</button>
            <button type="button" class="btn btn-small btn-ghost" data-key="resetUsage">重置用量</button>
            <button type="button" class="btn btn-small btn-danger" data-key="remove">删除凭据</button>
          </div>
        </details></li>`;
    }).join('');
    content.innerHTML = `
      <section class="pool-section" aria-labelledby="pool-strategy-title">
        <header class="pool-section-head"><h3 id="pool-strategy-title">搜索策略</h3></header>
        <form id="pool-config" class="pool-strategy-grid">
          <div class="field"><label for="pool-mode">搜索模式</label><select name="mode" id="pool-mode">
            <option value="single">单服务</option><option value="pool" ${pool.enabled ? 'selected' : ''}>搜索池</option>
          </select></div>
          <div class="field"><label for="pool-threshold">连续失败停用次数</label>
            <input type="number" name="threshold" id="pool-threshold" min="1" max="100" step="1" required value="${esc(pool.failureThreshold)}"></div>
          <button type="submit" class="btn btn-small">保存策略</button>
        </form>
      </section>
      <section class="pool-section" aria-labelledby="pool-route-title">
        <header class="pool-section-head"><h3 id="pool-route-title">服务顺序</h3></header>
        ${chainRows ? `<ol class="pool-list pool-route-list" aria-label="服务优先顺序">${chainRows}</ol>` : '<div class="pool-empty">尚未添加服务。</div>'}
        ${remaining.length ? `<form id="pool-chain-add" class="pool-route-add">
          <div class="field"><label for="pool-new-provider">待添加服务</label><select id="pool-new-provider" name="provider">
          ${remaining.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
          <button type="submit" class="btn btn-small">添加服务</button></form>` : ''}
      </section>
      <section class="pool-section" aria-labelledby="pool-keys-title">
        <header class="pool-section-head"><h3 id="pool-keys-title">搜索凭据</h3>
          <button type="button" class="btn btn-small btn-primary" data-key="add" ${providers.length ? '' : 'disabled'}>添加凭据</button></header>
        ${keys ? `<ul class="pool-list pool-key-list">${keys}</ul>` : '<div class="pool-empty">尚未添加凭据。每个参与搜索的服务至少需要一条凭据。</div>'}
      </section>`;
    if (draft) {
      const config = content.querySelector('#pool-config');
      config.elements.mode.value = draft.mode;
      config.elements.threshold.value = draft.threshold;
      config.dataset.modified = 'true';
    }
  }

  content.addEventListener('input', (event) => {
    if (event.target.form?.id === 'pool-config') event.target.form.dataset.modified = 'true';
  });
  content.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.id === 'pool-config') {
      request({ action: 'configure', enabled: form.elements.mode.value === 'pool', failureThreshold: form.elements.threshold.valueAsNumber });
    } else if (form.id === 'pool-chain-add') {
      request({ action: 'configure', expectedChain: data.pool.chain, chain: [...data.pool.chain, form.elements.provider.value] });
    }
  });
  content.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || busy) return;
    const move = button.dataset.chain;
    if (move) {
      const id = button.closest('[data-provider]').dataset.provider;
      const chain = [...data.pool.chain];
      const index = chain.indexOf(id);
      chain.splice(index, 1);
      if (move !== 'remove') chain.splice(index + (move === 'up' ? -1 : 1), 0, id);
      await request({action: 'configure', expectedChain: data.pool.chain, chain});
      return;
    }
    const action = button.dataset.key;
    if (!action) return;
    const id = button.closest('[data-key-id]')?.dataset.keyId;
    const key = data.pool.keys.find((k) => k.id === id);
    if (action === 'add' || action === 'edit') {
      openSearchPoolKey(data.providers, key, request, status);
    } else if (action === 'toggle') {
      await request({action: 'edit', id, enabled: !key.enabled});
    } else {
      const name = key.label || data.providers.find((p) => p.id === key.provider)?.name || key.provider;
      if (action === 'remove' && !(await uiConfirm(`确定删除搜索凭据「${name}」？`))) return;
      if (action === 'resetUsage' && !(await uiConfirm(`将「${name}」本地记录的用量归零？服务商账户的实际配额由服务商管理。`))) return;
      await request({action, id});
    }
  });
  refresh.addEventListener('click', () => request());
  request();
}

function openSearchPoolKey(providers, key, save, parentStatus) {
  const removed = key && !providers.some((p) => p.id === key.provider);
  const options = providers.map((p) => `<option value="${esc(p.id)}" ${p.id === key?.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')
    + (removed ? `<option value="${esc(key.provider)}" selected>${esc(key.provider)}（服务已移除）</option>` : '');
  const modal = modelModalShell({
    head: key ? '编辑搜索凭据' : '添加搜索凭据',
    body: `<div class="pool-editor-grid">
      <div class="field"><label for="pool-key-provider">搜索服务</label>
        <select id="pool-key-provider" name="provider" ${key ? 'disabled' : ''}>${options}</select></div>
      <div class="field"><label for="pool-key-label">名称（可选）</label>
        <input id="pool-key-label" type="text" name="label" maxlength="120" value="${esc(key?.label || '')}" placeholder="用于区分同一服务的凭据"></div>
      <div class="field pool-wide" data-pool-secret><label for="pool-key-secret">API Key</label>
        <input id="pool-key-secret" type="password" name="secret" maxlength="8192" autocomplete="new-password"
          placeholder="${key ? '留空保留现有凭据' : '留空使用服务默认凭据'}"></div>
      ${key ? '<label class="checkbox-row pool-wide"><input type="checkbox" name="useDefault">重新绑定为当前端点的默认凭据</label>' : ''}
      <div class="field"><label for="pool-key-quota">调用额度</label>
        <input id="pool-key-quota" type="number" name="quota" min="0" step="1" required value="${esc(key?.quota ?? 0)}" aria-describedby="pool-quota-note"></div>
      <div class="field"><label for="pool-key-period">额度周期</label><select id="pool-key-period" name="period">
        <option value="day">每天</option><option value="month">每月</option><option value="total">累计</option>
      </select></div>
      <span id="pool-quota-note" class="hint pool-wide">额度填 0 表示不限次数。每日、每月额度按服务器本地时间重置。</span>
    </div>`,
    foot: `<div role="alert" class="hint pool-footer-status"></div>
      <button type="button" class="btn btn-ghost" data-pool-cancel>取消</button>
      <button type="submit" class="btn btn-primary">保存凭据</button>`
  });
  modal.classList.add('pool-editor-overlay');
  const form = document.createElement('form');
  form.id = 'pool-key-form';
  const body = modal.querySelector('.model-modal-body');
  body.before(form);
  form.append(body, modal.querySelector('.model-modal-foot'));
  form.querySelector('[data-pool-cancel]').addEventListener('click', () => closeModelModal(modal));
  const { provider, label, secret, quota, period, useDefault } = form.elements;
  period.value = key?.period || 'month';
  function updateSecret() {
    const selected = providers.find((p) => p.id === provider.value);
    const canSet = selected && selected.supportsKeys !== false;
    if (useDefault) useDefault.disabled = !selected;
    form.querySelector('[data-pool-secret]').hidden = !canSet;
    secret.disabled = !canSet || !!useDefault?.checked;
    if (secret.disabled) secret.value = '';
  }
  provider.addEventListener('change', updateSecret);
  useDefault?.addEventListener('change', updateSecret);
  updateSecret();
  let submitting = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    const command = key ? { action: 'edit', id: key.id } : { action: 'add', provider: provider.value };
    Object.assign(command, { label: label.value.trim(), quota: quota.valueAsNumber, period: period.value });
    if (useDefault?.checked) command.apiKey = '';
    else if (!secret.disabled && secret.value.trim()) command.apiKey = secret.value.trim();
    submitting = true;
    form.inert = true;
    try {
      if (await save(command)) {
        secret.value = '';
        // 保存会重绘父列表，原先打开编辑器的按钮已经脱离 DOM。
        const manager = parentStatus.closest('.pool-manager-overlay');
        const row = [...manager.querySelectorAll('[data-key-id]')].find((el) => el.dataset.keyId === key?.id);
        modal._prevFocus = row?.querySelector('[data-key="edit"]') || manager.querySelector('[data-key="add"]');
        closeModelModal(modal);
      } else {
        form.querySelector('[role="alert"]').textContent = parentStatus.textContent;
      }
    } finally {
      submitting = false;
      form.inert = false;
    }
  });
}

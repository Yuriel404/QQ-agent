// 本地屏蔽名单、版本检查与会话管理。
'use strict';

// ── 屏蔽名单 ──
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  // 全局屏蔽名单（所有群+私聊都生效）的工作副本
  const pendingGlobal = new Set((cfg.globalBlocklist || []).map(String));
  // 机器人自己的 QQ 号：从状态接口取（cfg.onebot?.selfId 这个字段根本不存在，
  // 曾经恒为空串 —— "过滤机器人自己"形同虚设，机器人自己出现在可屏蔽列表里）
  const selfId = String(state.status?.onebot?.self?.userId || cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。<br>
        点名字旁的 ⊘ 可在本机全局屏蔽此人，适用于<b>所有群和私聊</b>。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size:11px">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }
  function isGlobalBlocked(uid) { return pendingGlobal.has(String(uid)); }

  function renderRight() {
    // 工具栏只建一次：曾经每次按键都整块重建 innerHTML（连搜索框一起销毁重建），
    // 输入一个字符就失焦 —— 搜索体验的根因就在这里。
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list"></div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => {
      kw = e.target.value.trim().toLowerCase();
      renderList();   // 只重绘名单，输入框保持原位原焦点
    });
    renderList();
  }

  function renderList() {
    const listBox = right.querySelector('#bl-list');
    if (!listBox) return;
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      const gb = isGlobalBlocked(m.userId);
      return `<label class="bl-member ${gb ? 'bl-global' : ''}" data-uid="${esc(m.userId)}">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size:11px">${esc(m.userId)}</span>
        <button type="button" class="bl-global-toggle ${gb ? 'on' : ''}" data-uid="${esc(m.userId)}" title="${gb ? '取消全局屏蔽' : '全局屏蔽（所有群+私聊）'}">${gb ? '⊘ 全局' : '⊘'}</button>
      </label>`;
    }).join('');
    listBox.innerHTML = rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>';
    listBox.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
    // 全局屏蔽切换（点 ⊘ 按钮）
    listBox.querySelectorAll('.bl-global-toggle').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(btn.dataset.uid);
        if (pendingGlobal.has(uid)) pendingGlobal.delete(uid); else pendingGlobal.add(uid);
        statusEl.textContent = pendingGlobal.size ? `全局屏蔽 ${pendingGlobal.size} 人（所有群+私聊）` : '';
        renderList();
      });
    });
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（SnowLuma 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      const localData = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ blocklist: { __replace__: pending }, globalBlocklist: [...pendingGlobal] })
      });
      state.config = localData.config;
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

function showUpdateToast(title, url, { onClose } = {}) {
  // 同类型只留一个（多次检查更新不堆叠）
  document.querySelectorAll('.update-toast').forEach((el) => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 180);
  });
  const el = document.createElement('div');
  el.className = 'update-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => {
    el.classList.add('closing');
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  });
}

// ── 自动检查更新 ──
// 节奏：启动时一次 + 之后每小时一次（version.json 作者手动改，这个频率足够）。
// 有更新 → 弹浮窗引导下载；用户手动关掉浮窗 → 本次启动内不再弹（重启恢复）。
// 但只要检测到新版，设置侧栏「桌面端」右侧就一直挂红点，直到版本追平。
let updateAvailable = false;
let updateToastDismissed = false;   // 本次启动内用户关过更新浮窗

function renderUpdateDot() {
  // 侧栏菜单每次重渲染都会重建（菜单 HTML 里已按 updateAvailable 画了点）；
  // 这里兜底处理"侧栏已渲染完、检测结果刚到"的情况。
  const item = document.querySelector('.settings-menu-item[data-section="desktop"]');
  if (!item) return;
  let dot = item.querySelector('.update-dot');
  if (updateAvailable && !dot) {
    dot = document.createElement('span');
    dot.className = 'update-dot';
    item.appendChild(dot);
  } else if (!updateAvailable && dot) {
    dot.remove();
  }
  // 桌面端页签的版本文案同步：有新版时"检查线上是否有新版本"→"发现新版本"
  const st = document.getElementById('update-status-text');
  if (st) {
    st.innerHTML = updateAvailable ? '<b style="color:var(--orange)">；发现新版本</b>' : '；检查线上是否有新版本';
  }
}

async function runUpdateCheck({ manual = false } = {}) {
  try {
    const data = await api('/api/update-check');
    if (!data?.ok) return data;   // 网络/服务器错误原样返回，手动检查要显示原因
    updateAvailable = !!data.hasUpdate;
    renderUpdateDot();
    // 自动检查弹浮窗；本次启动内被用户关过就不再弹（手动点「检查更新」除外）
    if (updateAvailable && (!updateToastDismissed || manual)) {
      showUpdateToast(
        `发现新版本 v${data.latest}（当前 v${data.current}）`,
        data.url,
        { onClose: () => { updateToastDismissed = true; } }
      );
    }
    return data;
  } catch { return null; }
}

// 会话列表「清空」：清空全部已结束的会话记录（保留运行中/等待中的）
$('#session-clear-btn')?.addEventListener('click', async () => {
  const total = (state.sessions || []).length;
  const running = (state.sessions || []).filter((s) => s.status === 'running' || s.status === 'waiting').length;
  if (!(await uiConfirm(`确定清空全部已结束的会话记录？\n\n共 ${total} 条，其中 ${running} 条运行中/等待中会保留。\n此操作不可恢复（不影响用量统计的历史数据）。`))) return;
  try {
    const r = await api('/api/sessions/clear-finished', { method: 'POST' });
    state.currentSessionId = null;
    $('#session-detail').innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
    await loadSessions({ quiet: true });
    renderSessionList();
  } catch (e) {
    alert(`清空失败：${e.message}`);
  }
});

// 会话列表「群发」：选若干群/私聊（或全选），发一条同样的消息。
// 走已存在的 /api/chats/:kind_:id/test-send 逐个发送（它会把消息记进存档，
// 与手动测试消息同一口径）；逐个发、逐个报结果，失败不中断后续目标。
$('#session-broadcast-btn')?.addEventListener('click', async () => {
  let groups = [], friends = [];
  try {
    const [g, f] = await Promise.all([api('/api/onebot/groups'), api('/api/onebot/friends')]);
    groups = g.groups || [];
    friends = f.friends || [];
  } catch (e) {
    alert(`拉取群/好友列表失败：${e.message}（OneBot 未连接？）`);
    return;
  }
  if (!groups.length && !friends.length) { alert('没拉到任何群和好友列表'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.dataset.animationShell = '1';
  const item = (kind, id, name) => `
    <label class="pick-item">
      <input type="checkbox" value="${kind}:${esc(String(id))}" />
      <span>${esc(name)}</span>
      <span class="muted">${esc(String(id))}</span>
    </label>`;
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head">群发消息（勾选目标后发送）</div>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button class="btn btn-small" id="bc-all-groups">全选群（${groups.length}）</button>
        <button class="btn btn-small" id="bc-all-friends">全选私聊（${friends.length}）</button>
        <button class="btn btn-small" id="bc-none">全不选</button>
      </div>
      <div class="modal-list">
        ${groups.length ? `<div class="muted" style="padding:4px 8px">群聊</div>` : ''}
        ${groups.map((g2) => item('group', g2.id, g2.name)).join('')}
        ${friends.length ? `<div class="muted" style="padding:4px 8px;margin-top:6px">私聊（好友）</div>` : ''}
        ${friends.map((f2) => item('private', f2.id, f2.name)).join('')}
      </div>
      <div class="field" style="margin-top:10px"><label>消息内容</label>
        <textarea id="bc-text" rows="3" placeholder="要发送的内容（所有勾选目标收到同一条）" style="width:100%"></textarea></div>
      <div id="bc-hint" class="muted" style="font-size:12px;margin-top:4px"></div>
      <div class="modal-foot">
        <button class="btn" id="bc-cancel">取消</button>
        <button class="btn btn-primary" id="bc-send">发送</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => closeAnimatedOverlay(overlay);
  overlay.querySelector('#bc-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const boxes = () => [...overlay.querySelectorAll('input[type=checkbox]')];
  const setChecked = (pred, on) => boxes().forEach((b) => { if (pred(b.value)) b.checked = on; });
  overlay.querySelector('#bc-all-groups').addEventListener('click', () => setChecked((v) => v.startsWith('group:'), true));
  overlay.querySelector('#bc-all-friends').addEventListener('click', () => setChecked((v) => v.startsWith('private:'), true));
  overlay.querySelector('#bc-none').addEventListener('click', () => setChecked(() => true, false));
  overlay.querySelector('#bc-send').addEventListener('click', async () => {
    const picked = boxes().filter((b) => b.checked).map((b) => b.value);
    const text = overlay.querySelector('#bc-text').value.trim();
    const hint = overlay.querySelector('#bc-hint');
    if (!picked.length) { hint.textContent = '先勾选至少一个目标'; return; }
    if (!text) { hint.textContent = '消息内容不能为空'; return; }
    const sendBtn = overlay.querySelector('#bc-send');
    sendBtn.disabled = true;
    const results = [];
    for (const key of picked) {
      const [kind, id] = key.split(':');
      try {
        await api(`/api/chats/${kind}_${id}/test-send`, { method: 'POST', body: JSON.stringify({ text }) });
        results.push(`✅ ${key}`);
      } catch (e) {
        results.push(`❌ ${key}：${e.message}`);
      }
      hint.textContent = `发送中… ${results.length}/${picked.length}`;
    }
    hint.textContent = `完成：${results.filter((r) => r.startsWith('✅')).length} 成功 / ${results.filter((r) => r.startsWith('❌')).length} 失败`;
    sendBtn.textContent = '已发送';
    sendBtn.disabled = false;
    setTimeout(close, 1600);
  });
});

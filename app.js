// ============================================
// OrthoSleep CRM — главный файл приложения
// ============================================

// --- НАСТРОЙКА SUPABASE ---
// Эти значения уже заполнены под твой проект
const SUPABASE_URL = 'https://towzlczesuxrtybbxfym.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvd3psY3plc3V4cnR5YmJ4ZnltIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxODk3OTEsImV4cCI6MjA5Nzc2NTc5MX0.co1Sjg3yYEZNBaWDghad7z9sjMlSxRoQolV2i-qCcdE';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- ГЛОБАЛЬНОЕ СОСТОЯНИЕ ---
const S = {
  user: null,        // текущий авторизованный пользователь (auth)
  profile: null,      // профиль (full_name, role)
  route: 'dashboard',  // текущий экран
  routeParams: {},
  stages: [],
  channels: [],
  categories: [],
  users: [],          // список менеджеров (для назначения)
  cache: {},          // простой кэш данных по экранам
};

// ============================================
// УТИЛИТЫ
// ============================================

function fmtMoney(n) {
  n = Number(n) || 0;
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' сом';
}

function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function fmtDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' в ' +
    date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(d) {
  if (!d) return '';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return Math.floor(diff / 60) + ' мин назад';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ч назад';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' дн назад';
  return fmtDate(d);
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
}

function renderAvatar(name, photoUrl, size = 42) {
  if (photoUrl) {
    return `<img src="${escapeHtml(photoUrl)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="avatar" style="display:none;width:${size}px;height:${size}px;font-size:${Math.round(size*0.36)}px;">${initials(name)}</div>`;
  }
  return `<div class="avatar" style="width:${size}px;height:${size}px;font-size:${Math.round(size*0.36)}px;">${initials(name)}</div>`;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️'}</span><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function navigate(route, params = {}) {
  S.route = route;
  S.routeParams = params;
  render();
}

function openSheet(html, opts = {}) {
  closeSheet();
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'active-sheet';
  overlay.innerHTML = `<div class="sheet">${html}</div>`;
  if (!opts.persistent) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  }
  document.body.appendChild(overlay);
}

function closeSheet() {
  const el = document.getElementById('active-sheet');
  if (el) el.remove();
}

async function withLoading(promiseFn) {
  try {
    return await promiseFn();
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Произошла ошибка', 'error');
    throw err;
  }
}

// ============================================
// АУТЕНТИФИКАЦИЯ
// ============================================

async function checkSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    S.user = data.session.user;
    await loadProfile();
    if (!S.profile || !S.profile.is_active) {
      await sb.auth.signOut();
      S.user = null;
      S.profile = null;
    }
  }
}

async function loadProfile() {
  const { data, error } = await sb.from('profiles').select('*').eq('id', S.user.id).single();
  if (!error) S.profile = data;
}

async function login(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Неверный email или пароль');
  S.user = data.user;
  await loadProfile();

  if (!S.profile || !S.profile.is_active) {
    await sb.auth.signOut();
    S.user = null;
    S.profile = null;
    throw new Error('Доступ заблокирован. Обратись к администратору.');
  }

  await loadReferenceData();
  navigate('dashboard');
}

async function logout() {
  await sb.auth.signOut();
  S.user = null;
  S.profile = null;
  navigate('dashboard');
}

// ============================================
// СПРАВОЧНЫЕ ДАННЫЕ (загружаются один раз при входе)
// ============================================

async function loadReferenceData() {
  const [stagesRes, channelsRes, categoriesRes, usersRes] = await Promise.all([
    sb.from('pipeline_stages').select('*').order('sort_order'),
    sb.from('channels').select('*').order('id'),
    sb.from('categories').select('*').order('sort_order'),
    sb.from('profiles').select('*').eq('is_active', true),
  ]);
  S.stages = stagesRes.data || [];
  S.channels = channelsRes.data || [];
  S.categories = categoriesRes.data || [];
  S.users = usersRes.data || [];
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

async function init() {
  await checkSession();
  if (S.user) {
    await loadReferenceData();
  }
  render();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      S.user = null;
      S.profile = null;
      render();
    }
  });
}

// ============================================
// ГЛАВНЫЙ РЕНДЕР
// ============================================

function render() {
  const app = document.getElementById('app');
  if (!S.user) {
    app.innerHTML = renderLogin();
    attachLoginHandlers();
    return;
  }
  if (!S.profile) {
    app.innerHTML = `<div class="loader-wrap"><div class="spinner"></div></div>`;
    return;
  }

  app.innerHTML = `
    ${renderTopbar()}
    <main class="scroll-y" id="main-content">
      <div class="loader-wrap"><div class="spinner"></div></div>
    </main>
    ${renderBottomNav()}
    ${renderFab()}
  `;

  loadRouteContent();
  if (S.route !== 'inbox') updateInboxUnreadDot(null);
  if (S.route !== 'notifications') updateNotificationsUnreadDot(null);
}

function renderTopbar() {
  const titles = {
    dashboard: ['Главная', S.profile?.full_name || ''],
    pipeline: ['Воронка продаж', 'Сделки по этапам'],
    clients: ['Клиенты', 'База клиентов'],
    calculator: ['Калькулятор цены', 'Расчёт по размеру и скидке'],
    products: ['Склад', 'Товары и остатки'],
    orders: ['Заказы', 'Оплата и доставка'],
    settings: ['Настройки', S.profile?.role === 'admin' ? 'Администратор' : 'Менеджер'],
    client_detail: ['Клиент', ''],
    tasks: ['Задачи', 'Все напоминания'],
    analytics: ['Аналитика', 'Продажи и эффективность'],
    inbox: ['Сообщения', 'Instagram · WhatsApp · Messenger'],
    ai_knowledge: ['Акции и информация', 'Что знает AI о бизнесе'],
    activity_logs: ['Логи активности', 'AI · Менеджеры · Система'],
    notifications: ['Уведомления', ''],
    deal_detail: ['Сделка', ''],
  };
  const [title, sub] = titles[S.route] || ['OrthoSleep', ''];
  const showBack = ['client_detail', 'deal_detail', 'tasks', 'analytics', 'inbox', 'ai_knowledge', 'activity_logs', 'notifications'].includes(S.route);

  return `
    <div class="topbar">
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        ${showBack ? `<button class="icon-btn" onclick="history.back ? navigate(routeBackTarget()) : null" data-back>←</button>` : ''}
        <div style="min-width:0;">
          <h2 style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${title}</h2>
          ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;">
        <button class="icon-btn" style="position:relative;" onclick="navigate('notifications')">🔔<span id="notif-unread-dot" style="display:none;position:absolute;top:4px;right:4px;width:9px;height:9px;border-radius:50%;background:var(--red);border:2px solid var(--bg);"></span></button>
        <button class="icon-btn" style="position:relative;" onclick="navigate('inbox')">💬<span id="inbox-unread-dot" style="display:none;position:absolute;top:4px;right:4px;width:9px;height:9px;border-radius:50%;background:var(--violet);border:2px solid var(--bg);"></span></button>
        <button class="icon-btn" onclick="navigate('settings')">👤</button>
      </div>
    </div>
  `;
}

function routeBackTarget() {
  if (S.route === 'client_detail') return 'clients';
  if (S.route === 'deal_detail') return 'pipeline';
  return 'dashboard';
}

function renderBottomNav() {
  const items = [
    { id: 'dashboard', icon: '🏠', label: 'Главная' },
    { id: 'pipeline', icon: '📊', label: 'Воронка' },
    { id: 'clients', icon: '👥', label: 'Клиенты' },
    { id: 'calculator', icon: '🧮', label: 'Калькулятор' },
    { id: 'products', icon: '🛏️', label: 'Склад' },
    { id: 'orders', icon: '📦', label: 'Заказы' },
  ];
  return `
    <div class="bottom-nav">
      ${items.map(it => `
        <button class="nav-item ${S.route === it.id ? 'active' : ''}" onclick="navigate('${it.id}')">
          <span class="nav-icon">${it.icon}</span>
          <span>${it.label}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function renderFab() {
  const fabMap = {
    clients: { icon: '+', action: 'openCreateClientSheet()' },
    pipeline: { icon: '+', action: 'openCreateDealSheet()' },
    products: { icon: '+', action: 'openCreateProductSheet()' },
  };
  const fab = fabMap[S.route];
  if (!fab) return '';
  return `<button class="fab" onclick="${fab.action}">${fab.icon}</button>`;
}

async function loadRouteContent() {
  const container = document.getElementById('main-content');
  if (!container) return;
  try {
    let html = '';
    switch (S.route) {
      case 'dashboard': html = await renderDashboard(); break;
      case 'pipeline': html = await renderPipeline(); break;
      case 'clients': html = await renderClients(); break;
      case 'calculator': html = await renderCalculator(); break;
      case 'client_detail': html = await renderClientDetail(S.routeParams.id); break;
      case 'deal_detail': html = await renderDealDetail(S.routeParams.id); break;
      case 'products': html = await renderProducts(); break;
      case 'orders': html = await renderOrders(); break;
      case 'settings': html = await renderSettings(); break;
      case 'tasks': html = await renderTasksPage(); break;
      case 'analytics': html = await renderAnalytics(); break;
      case 'inbox': html = await renderInbox(); break;
      case 'ai_knowledge': html = await renderAiKnowledge(); break;
      case 'activity_logs': html = await renderActivityLogs(); break;
      case 'notifications': html = await renderNotifications(); break;
      default: html = `<div class="page">Раздел не найден</div>`;
    }
    container.innerHTML = html;
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="page"><div class="empty-state"><div class="icon">⚠️</div><div class="title">Не удалось загрузить</div><div class="sub">${escapeHtml(err.message || '')}</div></div></div>`;
  }
}

// Запуск приложения
init();

// ============================================
// ЭКРАН ВХОДА
// ============================================

function renderLogin() {
  return `
    <div class="login-screen">
      <div class="login-logo">
        <div class="icon">🛏️</div>
        <h1>OrthoSleep CRM</h1>
        <p>Управление продажами матрасов</p>
      </div>
      <div class="login-card">
        <div id="login-error"></div>
        <form id="login-form">
          <div class="field">
            <label>Email</label>
            <input type="email" id="login-email" placeholder="you@example.com" autocomplete="username" required>
          </div>
          <div class="field">
            <label>Пароль</label>
            <input type="password" id="login-password" placeholder="••••••••" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn-primary" id="login-btn">Войти</button>
        </form>
      </div>
    </div>
  `;
}

function attachLoginHandlers() {
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn = document.getElementById('login-btn');
    const errBox = document.getElementById('login-error');
    errBox.innerHTML = '';
    btn.disabled = true;
    btn.textContent = 'Входим...';
    try {
      await login(email, password);
    } catch (err) {
      errBox.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });
}

// ============================================
// ГЛАВНАЯ (DASHBOARD)
// ============================================

async function renderDashboard() {
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

  const [dealsRes, ordersRes, clientsRes, lowStockRes, tasksRes] = await Promise.all([
    sb.from('deals').select('*, pipeline_stages(name,is_won,is_lost)').gte('created_at', monthStart.toISOString()),
    sb.from('orders').select('*').gte('created_at', monthStart.toISOString()),
    sb.from('clients').select('id', { count: 'exact', head: true }).gte('created_at', monthStart.toISOString()),
    sb.from('products').select('*').eq('is_active', true),
    sb.from('tasks').select('*, clients(full_name)').eq('is_done', false).order('due_at', { ascending: true }).limit(5),
  ]);

  const deals = dealsRes.data || [];
  const orders = ordersRes.data || [];
  const newClientsCount = clientsRes.count || 0;
  const products = lowStockRes.data || [];
  const tasks = tasksRes.data || [];

  const wonDeals = deals.filter(d => d.pipeline_stages?.is_won);
  const lostDeals = deals.filter(d => d.pipeline_stages?.is_lost);
  const activeDeals = deals.filter(d => !d.pipeline_stages?.is_won && !d.pipeline_stages?.is_lost);

  const revenue = orders.filter(o => o.payment_status === 'paid').reduce((s, o) => s + Number(o.total_amount), 0);
  const conversion = deals.length > 0 ? Math.round((wonDeals.length / deals.length) * 100) : 0;
  const lowStock = products.filter(p => p.stock_qty <= p.min_stock_qty);

  return `
    <div class="page">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Этот месяц</span>
        <span onclick="navigate('analytics')" style="color:var(--violet);font-size:12px;font-weight:600;">Аналитика →</span>
      </div>
      <div class="stat-grid">
        <div class="stat-card">
          <div class="label">💰 Выручка</div>
          <div class="value gold">${fmtMoney(revenue)}</div>
        </div>
        <div class="stat-card">
          <div class="label">🤝 Новых сделок</div>
          <div class="value">${deals.length}</div>
        </div>
        <div class="stat-card">
          <div class="label">✅ Завершено</div>
          <div class="value green">${wonDeals.length}</div>
          <div class="delta">Конверсия ${conversion}%</div>
        </div>
        <div class="stat-card">
          <div class="label">👥 Новых клиентов</div>
          <div class="value">${newClientsCount}</div>
        </div>
      </div>

      ${activeDeals.length > 0 ? `
        <div class="section-title">В работе сейчас (${activeDeals.length})</div>
        ${activeDeals.slice(0, 4).map(d => `
          <div class="card" onclick="navigate('deal_detail',{id:${d.id}})">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <div style="font-weight:600;font-size:14px;">${escapeHtml(d.title || 'Сделка №' + d.id)}</div>
                <div style="font-size:12px;color:var(--text-dim);margin-top:3px;">${escapeHtml(d.pipeline_stages?.name || '')}</div>
              </div>
              <div style="color:var(--gold);font-weight:700;">${fmtMoney(d.amount)}</div>
            </div>
          </div>
        `).join('')}
      ` : ''}

      ${lowStock.length > 0 ? `
        <div class="section-title">⚠️ Мало на складе</div>
        ${lowStock.slice(0, 4).map(p => `
          <div class="card" onclick="navigate('products')">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <div style="font-weight:600;font-size:13.5px;">${escapeHtml(p.name)} ${p.size ? `(${escapeHtml(p.size)})` : ''}</div>
              <span class="stock-pill ${p.stock_qty === 0 ? 'stock-out' : 'stock-low'}">${p.stock_qty} шт</span>
            </div>
          </div>
        `).join('')}
      ` : ''}

      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        <span>📌 Задачи</span>
        <span onclick="navigate('tasks')" style="color:var(--violet);font-size:12px;font-weight:600;">Все →</span>
      </div>
      ${tasks.length > 0 ? tasks.map(t => `
          <div class="card" onclick="openTaskActionsSheet(${t.id})">
            <div style="font-weight:600;font-size:13.5px;">${escapeHtml(t.title)}</div>
            <div style="font-size:12px;color:var(--text-dim);margin-top:3px;">
              ${t.clients ? escapeHtml(t.clients.full_name) + ' · ' : ''}${t.due_at ? fmtDateTime(t.due_at) : 'без срока'}
            </div>
          </div>
        `).join('') : `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:10px 0 18px;">Нет активных задач</div>`}

      ${deals.length === 0 && lowStock.length === 0 && tasks.length === 0 ? `
        <div class="empty-state">
          <div class="icon">🛏️</div>
          <div class="title">Пока нет данных за этот месяц</div>
          <div class="sub">Добавь первого клиента, чтобы начать</div>
        </div>
      ` : ''}
    </div>

  `;
}

// ============================================
// ВОРОНКА ПРОДАЖ (KANBAN)
// ============================================

let _pipelineManagerFilter = '';

async function renderPipeline() {
  return await loadPipelineContent(_pipelineManagerFilter);
}

async function loadPipelineContent(managerId) {
  _pipelineManagerFilter = managerId;
  let query = sb
    .from('deals')
    .select('*, clients(full_name, phone), pipeline_stages(id,name,color,is_won,is_lost)')
    .order('updated_at', { ascending: false });

  if (managerId) query = query.eq('assigned_to', managerId);

  const { data: deals, error } = await query;
  if (error) throw error;

  S.cache.pipelineDeals = deals;

  const filterBar = `
    <div style="padding:0 16px 12px;">
      <select onchange="switchPipelineManager(this.value)" style="width:auto;display:inline-block;">
        <option value="">Все менеджеры</option>
        ${S.users.map(u => `<option value="${u.id}" ${managerId === u.id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`).join('')}
      </select>
    </div>
  `;

  const columns = S.stages.map(stage => {
    const stageDeals = deals.filter(d => d.stage_id === stage.id);
    return `
      <div class="kanban-col">
        <div class="kanban-col-head">
          <span><span class="dot" style="background:${stage.color}"></span><span class="title">${escapeHtml(stage.name)}</span></span>
          <span class="count">${stageDeals.length}</span>
        </div>
        ${stageDeals.map(d => `
          <div class="deal-card" onclick="navigate('deal_detail',{id:${d.id}})">
            <div class="client">${escapeHtml(d.clients?.full_name || '—')}</div>
            <div class="amount">${fmtMoney(d.amount)}</div>
            <div class="meta-row">
              <span>${timeAgo(d.updated_at)}</span>
              ${!stage.is_won && !stage.is_lost ? `<button onclick="event.stopPropagation();openMoveDealSheet(${d.id},${stage.id})" style="background:var(--bg-elevated);border:1px solid var(--border-light);border-radius:7px;padding:3px 8px;font-size:10.5px;color:var(--text);">Этап →</button>` : ''}
            </div>
          </div>
        `).join('') || `<div style="text-align:center;color:var(--text-faint);font-size:12px;padding:16px 0;">Пусто</div>`}
      </div>
    `;
  }).join('');

  return `${filterBar}<div class="kanban-scroll">${columns}</div>`;
}

async function switchPipelineManager(managerId) {
  const container = document.getElementById('main-content');
  container.innerHTML = `<div class="loader-wrap"><div class="spinner"></div></div>`;
  container.innerHTML = await loadPipelineContent(managerId);
}

function openMoveDealSheet(dealId, currentStageId) {
  const stages = S.stages.filter(s => s.id !== currentStageId);
  openSheet(`
    <div class="sheet-header"><h3>Переместить сделку</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      ${stages.map(s => `
        <button class="card" style="width:100%;text-align:left;display:flex;align-items:center;gap:10px;" onclick="moveDealToStage(${dealId},${s.id},${s.is_lost})">
          <span class="dot" style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;"></span>
          <span style="font-weight:600;">${escapeHtml(s.name)}</span>
        </button>
      `).join('')}
    </div>
  `);
}

async function moveDealToStage(dealId, stageId, isLost) {
  let lostReason = null;
  if (isLost) {
    lostReason = prompt('Укажи причину отказа (можно пропустить):') || null;
  }
  closeSheet();
  await withLoading(async () => {
    const updates = { stage_id: stageId, updated_at: new Date().toISOString() };
    if (isLost) updates.lost_reason = lostReason;
    const stage = S.stages.find(s => s.id === stageId);
    if (stage?.is_won || stage?.is_lost) updates.closed_at = new Date().toISOString();
    else updates.closed_at = null;

    const { data: deal } = await sb.from('deals').select('client_id, amount').eq('id', dealId).single();
    const { error } = await sb.from('deals').update(updates).eq('id', dealId);
    if (error) throw error;

    await sb.from('interactions').insert({
      client_id: deal.client_id,
      deal_id: dealId,
      type: 'status_change',
      content: `Этап сделки изменён на: ${stage?.name || ''}${lostReason ? ' (причина: ' + lostReason + ')' : ''}`,
      created_by: S.user.id,
    });

    // Если выиграна — создаём заказ, если его ещё нет
    if (stage?.is_won) {
      const { data: existingOrder } = await sb.from('orders').select('id').eq('deal_id', dealId).maybeSingle();
      if (!existingOrder) {
        const { data: orderNumberData } = await sb.rpc('generate_order_number');
        await sb.from('orders').insert({
          deal_id: dealId,
          client_id: deal.client_id,
          order_number: orderNumberData || ('OS-' + Date.now()),
          total_amount: deal.amount,
        });
      }
    }

    showToast('Сделка перемещена');
    navigate('pipeline');
  });
}

function openCreateDealSheet() {
  openSheet(`
    <div class="sheet-header"><h3>Новая сделка</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field">
        <label>Клиент</label>
        <input type="text" id="deal-client-search" placeholder="Начни вводить имя или телефон..." oninput="searchClientsForDeal(this.value)">
        <div id="deal-client-results"></div>
      </div>
      <div id="deal-selected-client"></div>
      <div class="field">
        <label>Название сделки (необязательно)</label>
        <input type="text" id="deal-title" placeholder="напр. Матрас Sultan 160x200">
      </div>
      <div class="field">
        <label>Сумма (сом)</label>
        <input type="number" id="deal-amount" placeholder="0">
      </div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreateDeal()">Создать сделку</button>
    </div>
  `);
}

let _dealSelectedClientId = null;

async function searchClientsForDeal(query) {
  const resultsBox = document.getElementById('deal-client-results');
  if (!query || query.length < 2) { resultsBox.innerHTML = ''; return; }
  const { data } = await sb.from('clients').select('id,full_name,phone').or(`full_name.ilike.%${query}%,phone.ilike.%${query}%`).limit(5);
  resultsBox.innerHTML = (data || []).map(c => `
    <button class="card" style="width:100%;text-align:left;margin-top:6px;" onclick="selectClientForDeal(${c.id},'${escapeHtml(c.full_name).replace(/'/g,"\\'")}')">
      <div style="font-weight:600;font-size:13.5px;">${escapeHtml(c.full_name)}</div>
      <div style="font-size:12px;color:var(--text-dim);">${escapeHtml(c.phone || '')}</div>
    </button>
  `).join('') || `<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">Не найдено. <a style="color:var(--gold);" onclick="openCreateClientSheet(true)">Создать нового клиента</a></div>`;
}

function selectClientForDeal(id, name) {
  _dealSelectedClientId = id;
  document.getElementById('deal-client-results').innerHTML = '';
  document.getElementById('deal-client-search').value = name;
  document.getElementById('deal-selected-client').innerHTML = `<div style="font-size:12px;color:var(--green);margin-bottom:10px;">✓ Выбран клиент: ${escapeHtml(name)}</div>`;
}

async function submitCreateDeal() {
  if (!_dealSelectedClientId) { showToast('Выбери клиента из списка', 'error'); return; }
  const title = document.getElementById('deal-title').value.trim();
  const amount = parseFloat(document.getElementById('deal-amount').value) || 0;

  await withLoading(async () => {
    const firstStage = S.stages[0];
    const { data, error } = await sb.from('deals').insert({
      client_id: _dealSelectedClientId,
      stage_id: firstStage.id,
      title: title || null,
      amount,
      assigned_to: S.user.id,
    }).select().single();
    if (error) throw error;

    await sb.from('interactions').insert({
      client_id: _dealSelectedClientId, deal_id: data.id, type: 'system',
      content: 'Создана новая сделка', created_by: S.user.id,
    });

    _dealSelectedClientId = null;
    closeSheet();
    showToast('Сделка создана');
    navigate('pipeline');
  });
}

// ============================================
// КЛИЕНТЫ — СПИСОК
// ============================================

async function renderClients() {
  const { data: clients, error } = await sb
    .from('clients')
    .select('*, channels:primary_channel_id(name)')
    .order('created_at', { ascending: false });
  if (error) throw error;

  S.cache.clientsList = clients;

  return `
    <div class="page" style="padding-bottom:8px;">
      <input type="text" placeholder="🔍 Поиск по имени или телефону" oninput="filterClientsList(this.value)" style="margin-bottom:14px;">
      <div id="clients-list-container">
        ${renderClientsListItems(clients)}
      </div>
    </div>
  `;
}

function renderClientsListItems(clients) {
  if (!clients.length) {
    return `<div class="empty-state"><div class="icon">👥</div><div class="title">Пока нет клиентов</div><div class="sub">Нажми + чтобы добавить первого</div></div>`;
  }
  return clients.map(c => `
    <div class="client-row" onclick="navigate('client_detail',{id:${c.id}})">
      ${renderAvatar(c.full_name, c.photo_url, 42)}
      <div class="info">
        <div class="name">${escapeHtml(c.full_name)}</div>
        <div class="meta">
          ${c.phone ? `<span>${escapeHtml(c.phone)}</span>` : ''}
          ${c.channels?.name ? `<span class="badge" style="background:var(--bg-elevated);color:var(--text-dim);">${escapeHtml(c.channels.name)}</span>` : ''}
        </div>
      </div>
      <div style="color:var(--text-faint);font-size:18px;">›</div>
    </div>
  `).join('');
}

function filterClientsList(query) {
  const q = query.toLowerCase().trim();
  const filtered = (S.cache.clientsList || []).filter(c =>
    c.full_name.toLowerCase().includes(q) || (c.phone || '').includes(q)
  );
  document.getElementById('clients-list-container').innerHTML = renderClientsListItems(filtered);
}

function openCreateClientSheet(fromDeal = false) {
  const sourceOptions = S.channels.map(ch => `<option value="${ch.id}">${escapeHtml(ch.name)}</option>`).join('');
  openSheet(`
    <div class="sheet-header"><h3>Новый клиент</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Имя *</label><input type="text" id="new-client-name" placeholder="Имя клиента" required></div>
      <div class="field"><label>Телефон</label><input type="tel" id="new-client-phone" placeholder="+992 ..."></div>
      <div class="field"><label>Instagram (username)</label><input type="text" id="new-client-instagram" placeholder="без @"></div>
      <div class="field"><label>Источник</label><select id="new-client-source"><option value="">— не указан —</option>${sourceOptions}</select></div>
      <div class="field"><label>Город</label><input type="text" id="new-client-city" value="Худжанд"></div>
      <div class="field"><label>Адрес</label><textarea id="new-client-address" rows="2" placeholder="Адрес доставки"></textarea></div>
      <div class="field"><label>Заметка</label><textarea id="new-client-notes" rows="2" placeholder="Любая дополнительная информация"></textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreateClient(${fromDeal})">Сохранить</button>
    </div>
  `);
}

async function submitCreateClient(fromDeal) {
  const fullName = document.getElementById('new-client-name').value.trim();
  if (!fullName) { showToast('Укажи имя клиента', 'error'); return; }

  await withLoading(async () => {
    const payload = {
      full_name: fullName,
      phone: document.getElementById('new-client-phone').value.trim() || null,
      instagram_username: document.getElementById('new-client-instagram').value.trim() || null,
      primary_channel_id: document.getElementById('new-client-source').value || null,
      city: document.getElementById('new-client-city').value.trim() || 'Худжанд',
      address: document.getElementById('new-client-address').value.trim() || null,
      notes: document.getElementById('new-client-notes').value.trim() || null,
      assigned_to: S.user.id,
    };
    const { data, error } = await sb.from('clients').insert(payload).select().single();
    if (error) throw error;

    await sb.from('interactions').insert({
      client_id: data.id, type: 'system', content: 'Клиент создан', created_by: S.user.id,
    });

    closeSheet();
    showToast('Клиент добавлен');

    if (fromDeal) {
      selectClientForDeal(data.id, data.full_name);
      openCreateDealSheet();
      setTimeout(() => selectClientForDeal(data.id, data.full_name), 50);
    } else {
      navigate('clients');
    }
  });
}

// ============================================
// КАРТОЧКА КЛИЕНТА
// ============================================

async function renderClientDetail(id) {
  const [clientRes, dealsRes, historyRes] = await Promise.all([
    sb.from('clients').select('*, channels:primary_channel_id(name)').eq('id', id).single(),
    sb.from('deals').select('*, pipeline_stages(name,color,is_won,is_lost)').eq('client_id', id).order('created_at', { ascending: false }),
    sb.from('interactions').select('*, profiles(full_name)').eq('client_id', id).order('created_at', { ascending: false }).limit(100),
  ]);
  if (clientRes.error) throw clientRes.error;

  const client = clientRes.data;
  const deals = dealsRes.data || [];
  const history = historyRes.data || [];
  const totalSpent = deals.filter(d => d.pipeline_stages?.is_won).reduce((s, d) => s + Number(d.amount), 0);

  S.cache.currentClient = client;

  return `
    <div class="page">
      <div class="card" style="text-align:center;padding:22px 16px;">
        <div style="width:60px;height:60px;margin:0 auto 10px;display:flex;justify-content:center;">${renderAvatar(client.full_name, client.photo_url, 60)}</div>
        <div style="font-size:18px;font-weight:700;">${escapeHtml(client.full_name)}</div>
        <div style="color:var(--text-dim);font-size:13px;margin-top:3px;">${escapeHtml(client.phone || 'Телефон не указан')}</div>
        <div class="btn-row" style="margin-top:14px;">
          ${client.phone ? `<a href="tel:${client.phone}" class="btn-secondary" style="display:block;text-align:center;">📞 Позвонить</a>` : ''}
          <button class="btn-secondary" onclick="openEditClientSheet()">✏️ Изменить</button>
        </div>
        ${client.instagram_username || client.facebook_id || client.whatsapp_number ? `
          <button class="btn-primary" style="margin-top:10px;" onclick="openMessagesSheet(${client.id})">💬 Открыть переписку</button>
          <div class="theme-toggle" style="margin-top:10px;padding:10px 14px;" onclick="toggleClientAiManaged(${client.id},${client.ai_managed === false})">
            <span style="font-size:12.5px;font-weight:600;">🤖 ${client.ai_managed === false ? 'AI отключён для этого клиента' : 'AI отвечает этому клиенту'}</span>
            <div class="theme-switch" style="width:38px;height:22px;background:${client.ai_managed !== false ? 'rgba(0,185,86,0.18)' : 'var(--bg-elevated)'};border-color:${client.ai_managed !== false ? 'var(--accent)' : 'var(--border-light)'};">
              <div class="knob" style="width:18px;height:18px;top:1px;left:${client.ai_managed !== false ? '18px' : '1px'};background:${client.ai_managed !== false ? 'var(--accent)' : 'var(--text-faint)'};"></div>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="stat-grid">
        <div class="stat-card"><div class="label">Сделок</div><div class="value">${deals.length}</div></div>
        <div class="stat-card"><div class="label">Куплено на</div><div class="value gold">${fmtMoney(totalSpent)}</div></div>
      </div>

      <div class="card">
        ${client.instagram_username ? `<div style="margin-bottom:8px;font-size:13.5px;">📷 Instagram: <b>@${escapeHtml(client.instagram_username)}</b></div>` : ''}
        ${client.channels?.name ? `<div style="margin-bottom:8px;font-size:13.5px;">📍 Источник: <b>${escapeHtml(client.channels.name)}</b></div>` : ''}
        <div style="margin-bottom:8px;font-size:13.5px;">🏙️ Город: <b>${escapeHtml(client.city || '—')}</b></div>
        ${client.address ? `<div style="margin-bottom:8px;font-size:13.5px;">🏠 Адрес: ${escapeHtml(client.address)}</div>` : ''}
        ${client.notes ? `<div style="font-size:13.5px;color:var(--text-dim);">📝 ${escapeHtml(client.notes)}</div>` : ''}
      </div>

      <div class="section-title">Сделки</div>
      ${deals.length ? deals.map(d => `
        <div class="card" onclick="navigate('deal_detail',{id:${d.id}})">
          <div style="display:flex;justify-content:space-between;">
            <div>
              <div style="font-weight:600;font-size:13.5px;">${escapeHtml(d.title || 'Сделка №' + d.id)}</div>
              <div style="font-size:11.5px;color:${d.pipeline_stages?.color || 'var(--text-dim)'};margin-top:3px;">${escapeHtml(d.pipeline_stages?.name || '')}</div>
            </div>
            <div style="color:var(--gold);font-weight:700;">${fmtMoney(d.amount)}</div>
          </div>
        </div>
      `).join('') : `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:14px;">Сделок пока нет</div>`}
      <div class="btn-row" style="margin-top:4px;margin-bottom:18px;">
        <button class="btn-secondary" onclick="prefillDealForClient(${client.id},'${escapeHtml(client.full_name).replace(/'/g,"\\'")}')">+ Новая сделка</button>
        <button class="btn-secondary" onclick="openCreateTaskSheet(${client.id},'${escapeHtml(client.full_name).replace(/'/g,"\\'")}')">+ Задача</button>
      </div>

      <div class="section-title">История</div>
      <div class="card">
        <textarea id="new-note-text" rows="2" placeholder="Добавить заметку или результат звонка..." style="margin-bottom:8px;"></textarea>
        <button class="btn-secondary" onclick="addClientNote(${client.id})">Добавить запись</button>
      </div>
      ${history.length ? history.map(h => `
        <div class="timeline-item">
          <div class="timeline-dot" style="background:${h.type === 'ai_action' ? 'var(--violet)' : (h.type === 'system' || h.type === 'status_change' ? 'var(--blue)' : 'var(--gold)')}"></div>
          <div>
            <div class="txt">${escapeHtml(h.content)}</div>
            <div class="when">${h.profiles?.full_name ? escapeHtml(h.profiles.full_name) + ' · ' : ''}${timeAgo(h.created_at)}</div>
          </div>
        </div>
      `).join('') : `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:14px;">История пуста</div>`}

      ${S.profile.role === 'admin' ? `
        <button class="btn-secondary" style="margin-top:18px;color:var(--red);" onclick="confirmDeleteClient(${client.id})">Удалить клиента навсегда</button>
      ` : ''}
    </div>
  `;
}

async function confirmDeleteClient(clientId) {
  if (!confirm('Удалить клиента навсегда? Все его сделки, заказы и история также будут удалены. Это действие нельзя отменить.')) return;
  await withLoading(async () => {
    const { error } = await sb.from('clients').delete().eq('id', clientId);
    if (error) throw error;
    showToast('Клиент удалён');
    navigate('clients');
  });
}

function prefillDealForClient(id, name) {
  openCreateDealSheet();
  setTimeout(() => selectClientForDeal(id, name), 50);
}

async function addClientNote(clientId) {
  const text = document.getElementById('new-note-text').value.trim();
  if (!text) return;
  await withLoading(async () => {
    const { error } = await sb.from('interactions').insert({
      client_id: clientId, type: 'note', content: text, created_by: S.user.id,
    });
    if (error) throw error;
    showToast('Запись добавлена');
    navigate('client_detail', { id: clientId });
  });
}

function openEditClientSheet() {
  const c = S.cache.currentClient;
  openSheet(`
    <div class="sheet-header"><h3>Изменить клиента</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Имя</label><input type="text" id="edit-client-name" value="${escapeHtml(c.full_name)}"></div>
      <div class="field"><label>Телефон</label><input type="tel" id="edit-client-phone" value="${escapeHtml(c.phone || '')}"></div>
      <div class="field"><label>Instagram</label><input type="text" id="edit-client-instagram" value="${escapeHtml(c.instagram_username || '')}"></div>
      <div class="field"><label>Город</label><input type="text" id="edit-client-city" value="${escapeHtml(c.city || '')}"></div>
      <div class="field"><label>Адрес</label><textarea id="edit-client-address" rows="2">${escapeHtml(c.address || '')}</textarea></div>
      <div class="field"><label>Заметка</label><textarea id="edit-client-notes" rows="2">${escapeHtml(c.notes || '')}</textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditClient(${c.id})">Сохранить</button>
    </div>
  `);
}

async function submitEditClient(id) {
  await withLoading(async () => {
    const payload = {
      full_name: document.getElementById('edit-client-name').value.trim(),
      phone: document.getElementById('edit-client-phone').value.trim() || null,
      instagram_username: document.getElementById('edit-client-instagram').value.trim() || null,
      city: document.getElementById('edit-client-city').value.trim() || null,
      address: document.getElementById('edit-client-address').value.trim() || null,
      notes: document.getElementById('edit-client-notes').value.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from('clients').update(payload).eq('id', id);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate('client_detail', { id });
  });
}

// ============================================
// ДЕТАЛЬНАЯ КАРТОЧКА СДЕЛКИ
// ============================================

async function renderDealDetail(id) {
  const [dealRes, itemsRes, productsRes] = await Promise.all([
    sb.from('deals').select('*, clients(id,full_name,phone,instagram_username), pipeline_stages(id,name,color,is_won,is_lost)').eq('id', id).single(),
    sb.from('deal_items').select('*, products(name,size,sale_price)').eq('deal_id', id),
    sb.from('products').select('*').eq('is_active', true),
  ]);
  if (dealRes.error) throw dealRes.error;

  const deal = dealRes.data;
  const items = itemsRes.data || [];
  const products = productsRes.data || [];
  S.cache.currentDeal = deal;
  S.cache.allProducts = products;

  return `
    <div class="page">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;font-size:16px;">${escapeHtml(deal.title || 'Сделка №' + deal.id)}</div>
            <div onclick="navigate('client_detail',{id:${deal.clients.id}})" style="color:var(--blue);font-size:13px;margin-top:4px;">${escapeHtml(deal.clients.full_name)} ›</div>
          </div>
          <span class="badge" style="background:${deal.pipeline_stages.color}22;color:${deal.pipeline_stages.color};">${escapeHtml(deal.pipeline_stages.name)}</span>
        </div>
        <div class="btn-row" style="margin-top:12px;">
          ${deal.clients.phone ? `<a href="tel:${deal.clients.phone}" class="btn-secondary" style="display:block;text-align:center;">📞 Позвонить</a>` : ''}
          <button class="btn-secondary" onclick="openEditDealSheet(${deal.id})">✏️ Изменить</button>
        </div>
      </div>

      <div class="section-title">Товары в сделке</div>
      <div class="card" id="deal-items-box">
        ${renderDealItemsList(items)}
        <button class="btn-secondary" style="margin-top:8px;" onclick="openAddProductToDealSheet()">+ Добавить товар</button>
      </div>
      <div class="card" style="text-align:center;">
        <div style="font-size:12px;color:var(--text-dim);">Итоговая сумма сделки</div>
        <div style="font-size:24px;font-weight:700;color:var(--gold);margin-top:4px;">${fmtMoney(deal.amount)}</div>
      </div>

      ${!deal.pipeline_stages.is_won && !deal.pipeline_stages.is_lost ? `
        <button class="btn-primary" onclick="openMoveDealSheet(${deal.id},${deal.pipeline_stages.id})">Переместить на следующий этап →</button>
      ` : ''}
      <button class="btn-secondary" style="margin-top:10px;color:var(--red);" onclick="confirmDeleteDeal(${deal.id})">Удалить сделку</button>
    </div>
  `;
}

function openEditDealSheet(dealId) {
  const deal = S.cache.currentDeal;
  const userOptions = S.users.map(u => `<option value="${u.id}" ${deal.assigned_to === u.id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`).join('');
  openSheet(`
    <div class="sheet-header"><h3>Изменить сделку</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название</label><input type="text" id="edit-deal-title" value="${escapeHtml(deal.title || '')}"></div>
      <div class="field"><label>Ожидаемая дата закрытия</label><input type="date" id="edit-deal-date" value="${deal.expected_close_date || ''}"></div>
      <div class="field"><label>Ответственный менеджер</label><select id="edit-deal-assignee">${userOptions}</select></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditDeal(${dealId})">Сохранить</button>
    </div>
  `);
}

async function submitEditDeal(dealId) {
  const title = document.getElementById('edit-deal-title').value.trim();
  const date = document.getElementById('edit-deal-date').value;
  const assignee = document.getElementById('edit-deal-assignee').value;

  await withLoading(async () => {
    const { error } = await sb.from('deals').update({
      title: title || null,
      expected_close_date: date || null,
      assigned_to: assignee,
    }).eq('id', dealId);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate('deal_detail', { id: dealId });
  });
}

async function confirmDeleteDeal(dealId) {
  if (!confirm('Удалить сделку навсегда? Связанные товары и заказ также будут удалены.')) return;
  await withLoading(async () => {
    const { error } = await sb.from('deals').delete().eq('id', dealId);
    if (error) throw error;
    showToast('Сделка удалена');
    navigate('pipeline');
  });
}

function renderDealItemsList(items) {
  if (!items.length) return `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:8px 0;">Товары пока не добавлены</div>`;
  return items.map(it => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-weight:600;font-size:13.5px;">${escapeHtml(it.products?.name || '')} ${it.products?.size ? `(${escapeHtml(it.products.size)})` : ''}</div>
        <div style="font-size:12px;color:var(--text-dim);">${it.qty} × ${fmtMoney(it.price)}</div>
      </div>
      <button onclick="removeDealItem(${it.id},${S.cache.currentDeal.id})" style="background:none;border:none;color:var(--red);font-size:18px;">✕</button>
    </div>
  `).join('');
}

function openAddProductToDealSheet() {
  const products = S.cache.allProducts || [];
  openSheet(`
    <div class="sheet-header"><h3>Добавить товар</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      ${products.map(p => `
        <button class="card" style="width:100%;text-align:left;" onclick="addProductToDeal(${p.id},'${escapeHtml(p.name).replace(/'/g,"\\'")}',${p.sale_price})">
          <div style="display:flex;justify-content:space-between;">
            <div>
              <div style="font-weight:600;font-size:13.5px;">${escapeHtml(p.name)} ${p.size ? `(${escapeHtml(p.size)})` : ''}</div>
              <div style="font-size:12px;color:var(--text-dim);">Остаток: ${p.stock_qty} шт</div>
            </div>
            <div style="color:var(--gold);font-weight:700;">${fmtMoney(p.sale_price)}</div>
          </div>
        </button>
      `).join('') || `<div class="empty-state"><div class="sub">Нет товаров в каталоге. Добавь их на складе.</div></div>`}
    </div>
  `);
}

async function addProductToDeal(productId, name, price) {
  closeSheet();
  await withLoading(async () => {
    const dealId = S.cache.currentDeal.id;
    const { error } = await sb.from('deal_items').insert({ deal_id: dealId, product_id: productId, qty: 1, price });
    if (error) throw error;
    await recalcDealAmount(dealId);
    showToast('Товар добавлен');
    navigate('deal_detail', { id: dealId });
  });
}

async function removeDealItem(itemId, dealId) {
  await withLoading(async () => {
    const { error } = await sb.from('deal_items').delete().eq('id', itemId);
    if (error) throw error;
    await recalcDealAmount(dealId);
    navigate('deal_detail', { id: dealId });
  });
}

async function recalcDealAmount(dealId) {
  const { data: items } = await sb.from('deal_items').select('qty,price').eq('deal_id', dealId);
  const total = (items || []).reduce((s, i) => s + i.qty * Number(i.price), 0);
  await sb.from('deals').update({ amount: total }).eq('id', dealId);
}

// ============================================
// СКЛАД / ТОВАРЫ
// ============================================

async function renderProducts() {
  const { data: products, error } = await sb.from('products').select('*, categories(name)').eq('is_active', true).order('name');
  if (error) throw error;
  S.cache.allProducts = products;

  return `
    <div class="page">
      ${products.length ? products.map(p => {
        const stockClass = p.stock_qty === 0 ? 'stock-out' : (p.stock_qty <= p.min_stock_qty ? 'stock-low' : 'stock-ok');
        return `
        <div class="product-card">
          <div style="display:flex;justify-content:space-between;">
            <div>
              <div class="ptitle">${escapeHtml(p.name)}</div>
              <div class="pmeta">${escapeHtml(p.size || '')} ${p.categories?.name ? '· ' + escapeHtml(p.categories.name) : ''}</div>
            </div>
            <span class="stock-pill ${stockClass}">${p.stock_qty} шт</span>
          </div>
          <div class="prow">
            <div style="font-weight:700;color:var(--gold);">${fmtMoney(p.sale_price)}</div>
            <div class="btn-row" style="flex:0 0 auto;gap:6px;">
              <button class="btn-secondary" style="padding:8px 12px;" onclick="openStockMovementSheet(${p.id},'${escapeHtml(p.name).replace(/'/g,"\\'")}')">📦 Склад</button>
              <button class="btn-secondary" style="padding:8px 12px;" onclick="openEditProductSheet(${p.id})">✏️</button>
            </div>
          </div>
        </div>
      `}).join('') : `<div class="empty-state"><div class="icon">🛏️</div><div class="title">Каталог пуст</div><div class="sub">Нажми + чтобы добавить первый товар</div></div>`}
    </div>
  `;
}

function openCreateProductSheet() {
  const catOptions = S.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  openSheet(`
    <div class="sheet-header"><h3>Новый товар</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название *</label><input type="text" id="new-prod-name" placeholder="напр. Матрас Sultan"></div>
      <div class="field"><label>Категория</label><select id="new-prod-category"><option value="">— не указана —</option>${catOptions}</select></div>
      <div class="field"><label>Размер</label><input type="text" id="new-prod-size" placeholder="напр. 160x200"></div>
      <div class="field"><label>Закупочная цена</label><input type="number" id="new-prod-cost" placeholder="0"></div>
      <div class="field"><label>Цена продажи (база, 180 см) *</label><input type="number" id="new-prod-price" placeholder="0"></div>
      <div class="field"><label>Цена за 1 см ширины (для расчёта под любой размер)</label><input type="number" id="new-prod-pricepercm" placeholder="напр. 19.4" step="0.1"></div>
      <div class="field"><label>Минимальная цена продажи (нельзя продавать ниже)</label><input type="number" id="new-prod-minprice" placeholder="0"></div>
      <div class="field"><label>Максимальная скидка, %</label><input type="number" id="new-prod-maxdiscount" value="20"></div>
      <div class="field"><label>Начальный остаток (шт)</label><input type="number" id="new-prod-stock" placeholder="0"></div>
      <div class="field"><label>Минимальный остаток (для предупреждений)</label><input type="number" id="new-prod-minstock" value="2"></div>
      <div class="field"><label>Описание для AI (жёсткость, состав, для кого подходит)</label><textarea id="new-prod-description" rows="3" placeholder="напр. Средняя жёсткость, наполнитель — кокосовая койра и пена, подходит для людей с проблемами спины"></textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreateProduct()">Сохранить</button>
    </div>
  `);
}

async function submitCreateProduct() {
  const name = document.getElementById('new-prod-name').value.trim();
  const price = parseFloat(document.getElementById('new-prod-price').value) || 0;
  if (!name || !price) { showToast('Укажи название и цену продажи', 'error'); return; }

  await withLoading(async () => {
    const stockQty = parseInt(document.getElementById('new-prod-stock').value) || 0;
    const payload = {
      name,
      category_id: document.getElementById('new-prod-category').value || null,
      size: document.getElementById('new-prod-size').value.trim() || null,
      cost_price: parseFloat(document.getElementById('new-prod-cost').value) || 0,
      sale_price: price,
      price_per_cm: parseFloat(document.getElementById('new-prod-pricepercm').value) || null,
      min_price: parseFloat(document.getElementById('new-prod-minprice').value) || null,
      max_discount_percent: parseFloat(document.getElementById('new-prod-maxdiscount').value) || 20,
      base_width: 180,
      base_length: 200,
      stock_qty: stockQty,
      min_stock_qty: parseInt(document.getElementById('new-prod-minstock').value) || 2,
      description: document.getElementById('new-prod-description').value.trim() || null,
    };
    const { data, error } = await sb.from('products').insert(payload).select().single();
    if (error) throw error;

    if (stockQty > 0) {
      await sb.from('stock_movements').insert({ product_id: data.id, type: 'in', qty: stockQty, reason: 'Начальный остаток', created_by: S.user.id });
    }

    closeSheet();
    showToast('Товар добавлен');
    navigate('products');
  });
}

function openEditProductSheet(id) {
  const p = (S.cache.allProducts || []).find(x => x.id === id);
  if (!p) return;
  openSheet(`
    <div class="sheet-header"><h3>Изменить товар</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название</label><input type="text" id="edit-prod-name" value="${escapeHtml(p.name)}"></div>
      <div class="field"><label>Размер</label><input type="text" id="edit-prod-size" value="${escapeHtml(p.size || '')}"></div>
      <div class="field"><label>Закупочная цена</label><input type="number" id="edit-prod-cost" value="${p.cost_price}"></div>
      <div class="field"><label>Цена продажи (база, 180 см)</label><input type="number" id="edit-prod-price" value="${p.sale_price}"></div>
      <div class="field"><label>Цена за 1 см ширины</label><input type="number" id="edit-prod-pricepercm" value="${p.price_per_cm || ''}" step="0.1"></div>
      <div class="field"><label>Минимальная цена продажи</label><input type="number" id="edit-prod-minprice" value="${p.min_price || ''}"></div>
      <div class="field"><label>Максимальная скидка, %</label><input type="number" id="edit-prod-maxdiscount" value="${p.max_discount_percent || 20}"></div>
      <div class="field"><label>Минимальный остаток</label><input type="number" id="edit-prod-minstock" value="${p.min_stock_qty}"></div>
      <div class="field"><label>Описание для AI (жёсткость, состав, для кого подходит)</label><textarea id="edit-prod-description" rows="3">${escapeHtml(p.description || '')}</textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditProduct(${id})">Сохранить</button>
      <button class="btn-secondary" style="margin-top:8px;color:var(--red);" onclick="deactivateProduct(${id})">Скрыть товар (архив)</button>
    </div>
  `);
}

async function submitEditProduct(id) {
  await withLoading(async () => {
    const payload = {
      name: document.getElementById('edit-prod-name').value.trim(),
      size: document.getElementById('edit-prod-size').value.trim() || null,
      cost_price: parseFloat(document.getElementById('edit-prod-cost').value) || 0,
      sale_price: parseFloat(document.getElementById('edit-prod-price').value) || 0,
      price_per_cm: parseFloat(document.getElementById('edit-prod-pricepercm').value) || null,
      min_price: parseFloat(document.getElementById('edit-prod-minprice').value) || null,
      max_discount_percent: parseFloat(document.getElementById('edit-prod-maxdiscount').value) || 20,
      min_stock_qty: parseInt(document.getElementById('edit-prod-minstock').value) || 2,
      description: document.getElementById('edit-prod-description').value.trim() || null,
    };
    const { error } = await sb.from('products').update(payload).eq('id', id);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate('products');
  });
}

async function deactivateProduct(id) {
  if (!confirm('Скрыть товар из каталога? Его можно будет восстановить из базы данных.')) return;
  await withLoading(async () => {
    await sb.from('products').update({ is_active: false }).eq('id', id);
    closeSheet();
    showToast('Товар скрыт');
    navigate('products');
  });
}

function openStockMovementSheet(productId, name) {
  openSheet(`
    <div class="sheet-header"><h3>${escapeHtml(name)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="tabs">
        <button class="tab active" id="tab-in" onclick="setMovementType('in')">Приход</button>
        <button class="tab" id="tab-out" onclick="setMovementType('out')">Расход</button>
        <button class="tab" id="tab-adjustment" onclick="setMovementType('adjustment')">Корректировка</button>
      </div>
      <input type="hidden" id="movement-type" value="in">
      <div class="field"><label>Количество</label><input type="number" id="movement-qty" placeholder="напр. 5"></div>
      <div class="field"><label>Причина / комментарий</label><input type="text" id="movement-reason" placeholder="напр. Поставка от завода"></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitStockMovement(${productId})">Сохранить движение</button>
    </div>
  `);
}

function setMovementType(type) {
  document.getElementById('movement-type').value = type;
  ['in', 'out', 'adjustment'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === type);
  });
}

async function submitStockMovement(productId) {
  const type = document.getElementById('movement-type').value;
  let qty = parseInt(document.getElementById('movement-qty').value);
  const reason = document.getElementById('movement-reason').value.trim() || null;
  if (!qty || qty === 0) { showToast('Укажи количество', 'error'); return; }

  await withLoading(async () => {
    let signedQty = type === 'out' ? -Math.abs(qty) : Math.abs(qty);
    if (type === 'adjustment') signedQty = qty;

    const { error } = await sb.from('stock_movements').insert({
      product_id: productId, type, qty: signedQty, reason, created_by: S.user.id,
    });
    if (error) throw error;

    const { data: product } = await sb.from('products').select('stock_qty').eq('id', productId).single();
    await sb.from('products').update({ stock_qty: product.stock_qty + signedQty }).eq('id', productId);

    closeSheet();
    showToast('Движение склада сохранено');
    navigate('products');
  });
}

// ============================================
// ЗАКАЗЫ
// ============================================

async function renderOrders() {
  const { data: orders, error } = await sb
    .from('orders')
    .select('*, clients(full_name,phone)')
    .order('created_at', { ascending: false });
  if (error) throw error;

  const payLabels = { unpaid: ['Не оплачен', 'red'], partial: ['Частично', 'orange'], paid: ['Оплачен', 'green'] };
  const delLabels = { pending: ['Ожидает', 'text-dim'], preparing: ['Готовится', 'orange'], shipped: ['В пути', 'blue'], delivered: ['Доставлен', 'green'], cancelled: ['Отменён', 'red'] };

  return `
    <div class="page">
      ${orders.length ? orders.map(o => `
        <div class="card" onclick="openOrderDetailSheet(${o.id})">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-weight:700;font-size:14px;">${escapeHtml(o.order_number)}</div>
              <div style="font-size:12.5px;color:var(--text-dim);margin-top:2px;">${escapeHtml(o.clients?.full_name || '')}</div>
            </div>
            <div style="color:var(--gold);font-weight:700;">${fmtMoney(o.total_amount)}</div>
          </div>
          <div style="display:flex;gap:6px;margin-top:8px;">
            <span class="badge" style="background:var(--${payLabels[o.payment_status][1]},.15);color:var(--${payLabels[o.payment_status][1]});background:rgba(0,0,0,0.2);">${payLabels[o.payment_status][0]}</span>
            <span class="badge" style="background:rgba(0,0,0,0.2);color:var(--text-dim);">${delLabels[o.delivery_status][0]}</span>
          </div>
        </div>
      `).join('') : `<div class="empty-state"><div class="icon">📦</div><div class="title">Заказов пока нет</div><div class="sub">Заказы появятся после успешных сделок</div></div>`}
    </div>
  `;
}

async function openOrderDetailSheet(orderId) {
  const { data: order, error } = await sb.from('orders').select('*, clients(full_name,phone,address)').eq('id', orderId).single();
  if (error) { showToast('Не удалось загрузить заказ', 'error'); return; }
  S.cache.currentOrder = order;

  openSheet(`
    <div class="sheet-header"><h3>${escapeHtml(order.order_number)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="card">
        <div style="font-weight:600;">${escapeHtml(order.clients.full_name)}</div>
        ${order.clients.phone ? `<a href="tel:${order.clients.phone}" style="color:var(--blue);font-size:13px;">${escapeHtml(order.clients.phone)}</a>` : ''}
      </div>

      <div class="section-title">Оплата</div>
      <div class="field"><label>Оплачено (сом) из ${fmtMoney(order.total_amount)}</label><input type="number" id="order-paid-amount" value="${order.paid_amount}"></div>
      <button class="btn-secondary" onclick="submitOrderPayment(${orderId})">Обновить оплату</button>

      <div class="section-title">Доставка</div>
      <select id="order-delivery-status" style="margin-bottom:10px;">
        <option value="pending" ${order.delivery_status === 'pending' ? 'selected' : ''}>Ожидает</option>
        <option value="preparing" ${order.delivery_status === 'preparing' ? 'selected' : ''}>Готовится</option>
        <option value="shipped" ${order.delivery_status === 'shipped' ? 'selected' : ''}>В пути</option>
        <option value="delivered" ${order.delivery_status === 'delivered' ? 'selected' : ''}>Доставлен</option>
        <option value="cancelled" ${order.delivery_status === 'cancelled' ? 'selected' : ''}>Отменён</option>
      </select>
      <textarea id="order-delivery-address" rows="2" placeholder="Адрес доставки">${escapeHtml(order.delivery_address || order.clients.address || '')}</textarea>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitOrderDelivery(${orderId})">Сохранить доставку</button>
    </div>
  `);
}

async function submitOrderPayment(orderId) {
  const paidAmount = parseFloat(document.getElementById('order-paid-amount').value) || 0;
  await withLoading(async () => {
    const order = S.cache.currentOrder;
    let status = 'unpaid';
    if (paidAmount >= order.total_amount && paidAmount > 0) status = 'paid';
    else if (paidAmount > 0) status = 'partial';

    const { error } = await sb.from('orders').update({ paid_amount: paidAmount, payment_status: status }).eq('id', orderId);
    if (error) throw error;

    await sb.from('interactions').insert({
      client_id: order.client_id, deal_id: order.deal_id, type: 'system',
      content: `Оплата обновлена: ${fmtMoney(paidAmount)} (статус: ${status})`, created_by: S.user.id,
    });

    showToast('Оплата обновлена');
    closeSheet();
    navigate('orders');
  });
}

async function submitOrderDelivery(orderId) {
  const status = document.getElementById('order-delivery-status').value;
  const address = document.getElementById('order-delivery-address').value.trim();

  await withLoading(async () => {
    const { error } = await sb.from('orders').update({ delivery_status: status, delivery_address: address || null }).eq('id', orderId);
    if (error) throw error;

    // Если доставлен — списываем со склада (один раз)
    if (status === 'delivered') {
      const order = S.cache.currentOrder;
      const { count } = await sb.from('stock_movements').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('type', 'out');
      if (!count) {
        const { data: items } = await sb.from('deal_items').select('*').eq('deal_id', order.deal_id);
        for (const item of (items || [])) {
          await sb.from('stock_movements').insert({
            product_id: item.product_id, type: 'out', qty: -Math.abs(item.qty),
            reason: 'Доставка заказа', order_id: orderId, created_by: S.user.id,
          });
          const { data: prod } = await sb.from('products').select('stock_qty').eq('id', item.product_id).single();
          await sb.from('products').update({ stock_qty: prod.stock_qty - item.qty }).eq('id', item.product_id);
        }
      }
      await sb.from('interactions').insert({
        client_id: order.client_id, deal_id: order.deal_id, type: 'system',
        content: 'Заказ доставлен клиенту', created_by: S.user.id,
      });
    }

    showToast('Доставка обновлена');
    closeSheet();
    navigate('orders');
  });
}

// ============================================
// НАСТРОЙКИ
// ============================================

async function renderSettings() {
  const isAdmin = S.profile.role === 'admin';
  let managersHtml = '';
  if (isAdmin) {
    // Подгружаем актуальный список (включая неактивных) прямо из БД
    const { data: allProfiles } = await sb.from('profiles').select('*').order('created_at');
    S.cache.allProfiles = allProfiles || [];

    managersHtml = `
      <div class="section-title">Команда</div>
      ${(allProfiles || []).map(u => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="min-width:0;">
              <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;">
                ${escapeHtml(u.full_name)}
                ${!u.is_active ? '<span class="badge" style="background:rgba(226,92,92,0.15);color:var(--red);">блокирован</span>' : ''}
              </div>
              <div style="font-size:11.5px;color:var(--text-dim);">${u.role === 'admin' ? 'Администратор' : 'Менеджер'}</div>
            </div>
            ${u.id !== S.user.id ? `<button class="icon-btn" style="width:32px;height:32px;font-size:14px;" onclick="openManagerActionsSheet('${u.id}','${escapeHtml(u.full_name).replace(/'/g,"\\'")}',${u.is_active})">⋯</button>` : ''}
          </div>
        </div>
      `).join('')}
      <button class="btn-secondary" style="margin-top:4px;margin-bottom:18px;" onclick="openAddManagerSheet()">+ Добавить менеджера</button>
    `;
  }

  return `
    <div class="page">
      <div class="card" style="text-align:center;padding:22px;">
        <div class="avatar" style="width:56px;height:56px;font-size:20px;margin:0 auto 10px;">${initials(S.profile.full_name)}</div>
        <div style="font-weight:700;font-size:16px;">${escapeHtml(S.profile.full_name)}</div>
        <div style="color:var(--text-dim);font-size:12.5px;margin-top:2px;">${escapeHtml(S.user.email)}</div>
        <div style="margin-top:6px;"><span class="badge" style="background:var(--gold-bg);color:var(--gold);">${isAdmin ? 'Администратор' : 'Менеджер'}</span></div>
      </div>

      <div class="theme-toggle" onclick="toggleTheme()">
        <span style="font-weight:600;font-size:13.5px;">🌗 Тёмная / светлая тема</span>
        <div class="theme-switch"><div class="knob"></div></div>
      </div>

      ${managersHtml}

      ${S.profile.role === 'admin' ? await renderAiAgentSection() : ''}

      ${S.profile.role === 'admin' ? `
        <button class="btn-secondary" style="margin-bottom:14px;" onclick="navigate('ai_knowledge')">📚 Акции и информация для AI</button>
        <button class="btn-secondary" style="margin-bottom:14px;" onclick="navigate('activity_logs')">📋 Логи активности</button>
        <button class="btn-secondary" style="margin-bottom:14px;" onclick="downloadFullBackup()">💾 Скачать полный бэкап (JSON)</button>
        <button class="btn-secondary" style="margin-bottom:14px;" onclick="downloadClientsCsv()">📤 Экспорт клиентов (CSV)</button>
      ` : ''}

      ${S.profile.role === 'admin' ? `
        <div class="section-title">🔧 Диагностика каналов и AI</div>
        <div class="card">
          <div style="font-size:11.5px;color:var(--text-dim);font-weight:700;margin-bottom:6px;">Instagram</div>
          <div class="btn-row" style="margin-bottom:12px;">
            <button class="btn-secondary" onclick="checkChannelDiagnostics('instagram-webhook','check_subscription')">Подписка</button>
            <button class="btn-secondary" onclick="checkChannelDiagnostics('instagram-webhook','subscribe')">Подписаться</button>
          </div>
          <div style="font-size:11.5px;color:var(--text-dim);font-weight:700;margin-bottom:6px;">Facebook Messenger</div>
          <div class="btn-row" style="margin-bottom:12px;">
            <button class="btn-secondary" onclick="checkChannelDiagnostics('facebook-webhook','check_config')">Проверить</button>
          </div>
          <div style="font-size:11.5px;color:var(--text-dim);font-weight:700;margin-bottom:6px;">WhatsApp</div>
          <div class="btn-row" style="margin-bottom:12px;">
            <button class="btn-secondary" onclick="checkChannelDiagnostics('whatsapp-webhook','check_config')">Проверить настройку</button>
          </div>
          <div style="font-size:11.5px;color:var(--text-dim);font-weight:700;margin-bottom:6px;">AI-агент</div>
          <div class="btn-row" style="margin-bottom:4px;">
            <button class="btn-secondary" onclick="checkAiAgentStatus()">Проверить AI</button>
          </div>
          <div id="diag-result" style="margin-top:10px;font-size:12px;color:var(--text-dim);white-space:pre-wrap;word-break:break-all;"></div>
        </div>
      ` : ''}

      <div class="section-title">Приложение</div>
      <div class="card" style="font-size:13px;color:var(--text-dim);line-height:1.6;">
        🛏️ OrthoSleep CRM<br>
        Версия 1.1 · Этап 1 (фундамент) + Калькулятор<br>
        Подключение Instagram/WhatsApp/AI — следующие этапы
      </div>

      <button class="btn-secondary" style="margin-top:6px;color:var(--red);" onclick="confirmLogout()">Выйти из аккаунта</button>
    </div>
  `;
}

async function checkChannelDiagnostics(functionName, action) {
  const box = document.getElementById('diag-result');
  box.textContent = 'Загрузка...';
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData.session?.access_token;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}?action=${action}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    box.textContent = JSON.stringify(data, null, 2);
    if (data.success && action === 'subscribe') showToast('Подписка обновлена');
  } catch (err) {
    box.textContent = 'Ошибка: ' + err.message;
  }
}

async function checkAiAgentStatus() {
  const box = document.getElementById('diag-result');
  box.textContent = 'Загрузка...';
  try {
    const { data: settings, error } = await sb.from('ai_agent_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;

    const { count: aiManagedCount } = await sb.from('clients').select('id', { count: 'exact', head: true }).neq('ai_managed', false);
    const { count: totalClients } = await sb.from('clients').select('id', { count: 'exact', head: true });

    box.textContent = JSON.stringify({
      is_enabled: settings?.is_enabled,
      auto_reply_enabled: settings?.auto_reply_enabled,
      clients_with_ai_on: aiManagedCount,
      total_clients: totalClients,
      anthropic_key_note: 'Сам ключ ANTHROPIC_API_KEY проверить отсюда нельзя — если AI не отвечает, проверь логи функции ai-agent в Supabase.',
    }, null, 2);
  } catch (err) {
    box.textContent = 'Ошибка: ' + err.message;
  }
}

function confirmLogout() {
  if (confirm('Выйти из аккаунта?')) logout();
}

// ============================================
// УПРАВЛЕНИЕ КОМАНДОЙ (через Edge Function manage-managers)
// ============================================

async function callManageManagers(payload) {
  const { data: sessionData } = await sb.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-managers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Произошла ошибка');
  return data;
}

function openAddManagerSheet() {
  openSheet(`
    <div class="sheet-header"><h3>Новый менеджер</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Имя</label><input type="text" id="new-mgr-name" placeholder="Имя менеджера"></div>
      <div class="field"><label>Email (для входа)</label><input type="email" id="new-mgr-email" placeholder="manager@example.com"></div>
      <div class="field"><label>Пароль (минимум 6 символов)</label><input type="password" id="new-mgr-password" placeholder="••••••••"></div>
      <div style="font-size:12px;color:var(--text-faint);">Менеджер сможет войти в приложение с этим email и паролем.</div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitAddManager()">Создать менеджера</button>
    </div>
  `);
}

async function submitAddManager() {
  const fullName = document.getElementById('new-mgr-name').value.trim();
  const email = document.getElementById('new-mgr-email').value.trim();
  const password = document.getElementById('new-mgr-password').value;

  if (!fullName || !email || password.length < 6) {
    showToast('Заполни все поля. Пароль не короче 6 символов', 'error');
    return;
  }

  await withLoading(async () => {
    await callManageManagers({ action: 'create', email, password, full_name: fullName });
    closeSheet();
    showToast('Менеджер создан');
    await loadReferenceData();
    navigate('settings');
  });
}

function openManagerActionsSheet(userId, name, isActive) {
  openSheet(`
    <div class="sheet-header"><h3>${escapeHtml(name)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <button class="card" style="width:100%;text-align:left;" onclick="openResetPasswordSheet('${userId}','${escapeHtml(name).replace(/'/g,"\\'")}')">
        🔑 <span style="font-weight:600;">Сбросить пароль</span>
      </button>
      <button class="card" style="width:100%;text-align:left;" onclick="toggleManagerActive('${userId}',${!isActive})">
        ${isActive ? '🚫 <span style="font-weight:600;">Заблокировать доступ</span>' : '✅ <span style="font-weight:600;">Разблокировать доступ</span>'}
      </button>
      <button class="card" style="width:100%;text-align:left;color:var(--red);" onclick="confirmDeleteManager('${userId}','${escapeHtml(name).replace(/'/g,"\\'")}')">
        🗑️ <span style="font-weight:600;">Удалить менеджера навсегда</span>
      </button>
    </div>
  `);
}

function openResetPasswordSheet(userId, name) {
  openSheet(`
    <div class="sheet-header"><h3>Новый пароль для ${escapeHtml(name)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Новый пароль (минимум 6 символов)</label><input type="password" id="reset-pwd-input" placeholder="••••••••"></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitResetPassword('${userId}')">Сохранить новый пароль</button>
    </div>
  `);
}

async function submitResetPassword(userId) {
  const newPassword = document.getElementById('reset-pwd-input').value;
  if (newPassword.length < 6) { showToast('Пароль слишком короткий', 'error'); return; }

  await withLoading(async () => {
    await callManageManagers({ action: 'reset_password', user_id: userId, new_password: newPassword });
    closeSheet();
    showToast('Пароль обновлён');
  });
}

async function toggleManagerActive(userId, newActiveState) {
  closeSheet();
  await withLoading(async () => {
    await callManageManagers({ action: 'toggle_active', user_id: userId, is_active: newActiveState });
    showToast(newActiveState ? 'Доступ восстановлен' : 'Доступ заблокирован');
    await loadReferenceData();
    navigate('settings');
  });
}

function confirmDeleteManager(userId, name) {
  closeSheet();
  if (!confirm(`Удалить менеджера «${name}» навсегда? Это действие нельзя отменить.`)) return;
  withLoading(async () => {
    await callManageManagers({ action: 'delete', user_id: userId });
    showToast('Менеджер удалён');
    await loadReferenceData();
    navigate('settings');
  });
}

// ============================================
// КАЛЬКУЛЯТОР ЦЕНЫ ПО РАЗМЕРУ
// ============================================

let _calcState = { width: 180, discountPercent: 0 };

async function renderCalculator() {
  const { data: products, error } = await sb.from('products').select('*').eq('is_active', true).order('name');
  if (error) throw error;
  S.cache.allProducts = products;

  const calcableProducts = products.filter(p => p.price_per_cm);
  const noCalcProducts = products.filter(p => !p.price_per_cm);

  return `
    <div class="page">
      <div class="calc-input-card">
        <div style="font-size:12px;color:var(--text-dim);font-weight:600;margin-bottom:8px;">РАЗМЕР МАТРАСА (СМ)</div>
        <div class="calc-size-row">
          <input type="number" id="calc-width" value="${_calcState.width}" placeholder="Ширина" oninput="onCalcInputChange()">
          <span class="x">×</span>
          <input type="number" id="calc-length" value="200" placeholder="Длина">
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;">Длина обычно фиксирована — 200 см</div>

        <div style="font-size:12px;color:var(--text-dim);font-weight:600;margin:16px 0 8px;">СКИДКА</div>
        <div class="calc-discount-row">
          <button class="discount-chip ${_calcState.discountPercent === 0 ? 'active' : ''}" onclick="setCalcDiscount(0)">Без скидки</button>
          <button class="discount-chip ${_calcState.discountPercent === 10 ? 'active' : ''}" onclick="setCalcDiscount(10)">−10%</button>
          <button class="discount-chip ${_calcState.discountPercent === 15 ? 'active' : ''}" onclick="setCalcDiscount(15)">−15%</button>
          <button class="discount-chip ${_calcState.discountPercent === 20 ? 'active' : ''}" onclick="setCalcDiscount(20)">−20%</button>
        </div>
        <div style="margin-top:10px;">
          <input type="number" id="calc-custom-discount" placeholder="Своя скидка, %" value="${[0,10,15,20].includes(_calcState.discountPercent) ? '' : _calcState.discountPercent}" oninput="setCalcDiscount(parseFloat(this.value)||0, true)">
        </div>
      </div>

      <div class="section-title">Цена по моделям</div>
      <div id="calc-results">
        ${renderCalcResults(calcableProducts)}
      </div>

      ${noCalcProducts.length ? `
        <div class="section-title">Без формулы расчёта</div>
        <div style="font-size:12px;color:var(--text-faint);margin-bottom:8px;">У этих товаров не задана «цена за 1 см» — добавь её в карточке товара на складе, чтобы они считались автоматически.</div>
        ${noCalcProducts.map(p => `<div class="card" onclick="navigate('products')">${escapeHtml(p.name)} — ${fmtMoney(p.sale_price)} (фикс.)</div>`).join('')}
      ` : ''}
    </div>
  `;
}

function onCalcInputChange() {
  _calcState.width = parseFloat(document.getElementById('calc-width').value) || 0;
  recalcCalculator();
}

function setCalcDiscount(percent, fromCustom = false) {
  _calcState.discountPercent = percent;
  if (!fromCustom) document.getElementById('calc-custom-discount').value = '';
  recalcCalculator();
}

function recalcCalculator() {
  const products = (S.cache.allProducts || []).filter(p => p.price_per_cm);
  document.getElementById('calc-results').innerHTML = renderCalcResults(products);
  // обновляем активные чипы
  document.querySelectorAll('.discount-chip').forEach((el, i) => {
    const vals = [0, 10, 15, 20];
    el.classList.toggle('active', vals[i] === _calcState.discountPercent);
  });
}

function renderCalcResults(products) {
  const width = _calcState.width || 0;
  if (!width) return `<div class="empty-state" style="padding:24px;"><div class="sub">Введи ширину матраса, чтобы увидеть цены</div></div>`;

  const results = products.map(p => {
    const rawPrice = p.price_per_cm * width;
    const discounted = rawPrice * (1 - _calcState.discountPercent / 100);
    const minPrice = p.min_price || 0;
    const belowMin = minPrice > 0 && discounted < minPrice;
    const maxAllowed = p.max_discount_percent || 20;
    const exceedsMax = _calcState.discountPercent > maxAllowed;
    return { product: p, rawPrice, discounted, belowMin, exceedsMax, maxAllowed };
  }).sort((a, b) => a.discounted - b.discounted);

  if (!results.length) return `<div class="empty-state" style="padding:24px;"><div class="sub">Нет товаров с заданной ценой за см</div></div>`;

  const cheapest = results[0];

  return results.map(r => `
    <div class="calc-result-card ${r === cheapest ? 'best' : ''}">
      <div>
        <div class="model-name">${escapeHtml(r.product.name)}</div>
        <div class="model-sub">${width} × 200 см ${r.product.price_per_cm ? '· ' + r.product.price_per_cm + ' сом/см' : ''}</div>
        ${r.exceedsMax ? `<div class="calc-warning">⚠️ Скидка выше максимума (${r.maxAllowed}%)</div>` : ''}
        ${r.belowMin ? `<div class="calc-warning">⚠️ Ниже минимальной цены (${fmtMoney(r.product.min_price)})</div>` : ''}
      </div>
      <div style="text-align:right;">
        ${_calcState.discountPercent > 0 ? `<div class="price-old">${fmtMoney(r.rawPrice)}</div>` : ''}
        <div class="price">${fmtMoney(r.discounted)}</div>
        <button style="margin-top:6px;background:var(--violet-bg);border:1px solid var(--violet);color:var(--violet);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;" onclick="attachCalcResultToDeal(${r.product.id},'${escapeHtml(r.product.name).replace(/'/g,"\\'")}',${r.discounted.toFixed(2)},${width})">В сделку →</button>
      </div>
    </div>
  `).join('');
}

function attachCalcResultToDeal(productId, productName, price, width) {
  openSheet(`
    <div class="sheet-header"><h3>Добавить в сделку</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="card">
        <div style="font-weight:600;">${escapeHtml(productName)} (${width}×200)</div>
        <div style="color:var(--accent);font-weight:700;margin-top:4px;">${fmtMoney(price)}</div>
      </div>
      <div class="field" style="margin-top:12px;">
        <label>Клиент</label>
        <input type="text" id="calc-deal-client-search" placeholder="Начни вводить имя или телефон..." oninput="searchClientsForCalcDeal(this.value)">
        <div id="calc-deal-client-results"></div>
      </div>
      <div id="calc-deal-selected-client"></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCalcDealAttach(${productId},'${escapeHtml(productName).replace(/'/g,"\\'")}',${price})">Создать сделку с этим товаром</button>
    </div>
  `);
}

let _calcDealClientId = null;

async function searchClientsForCalcDeal(query) {
  const box = document.getElementById('calc-deal-client-results');
  if (!query || query.length < 2) { box.innerHTML = ''; return; }
  const { data } = await sb.from('clients').select('id,full_name,phone').or(`full_name.ilike.%${query}%,phone.ilike.%${query}%`).limit(5);
  box.innerHTML = (data || []).map(c => `
    <button class="card" style="width:100%;text-align:left;margin-top:6px;" onclick="selectClientForCalcDeal(${c.id},'${escapeHtml(c.full_name).replace(/'/g,"\\'")}')">
      <div style="font-weight:600;font-size:13.5px;">${escapeHtml(c.full_name)}</div>
      <div style="font-size:12px;color:var(--text-dim);">${escapeHtml(c.phone || '')}</div>
    </button>
  `).join('') || `<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">Не найдено</div>`;
}

function selectClientForCalcDeal(id, name) {
  _calcDealClientId = id;
  document.getElementById('calc-deal-client-results').innerHTML = '';
  document.getElementById('calc-deal-client-search').value = name;
  document.getElementById('calc-deal-selected-client').innerHTML = `<div style="font-size:12px;color:var(--accent);margin-bottom:6px;">✓ Выбран клиент: ${escapeHtml(name)}</div>`;
}

async function submitCalcDealAttach(productId, productName, price) {
  if (!_calcDealClientId) { showToast('Выбери клиента из списка', 'error'); return; }
  await withLoading(async () => {
    const firstStage = S.stages[0];
    const { data: deal, error } = await sb.from('deals').insert({
      client_id: _calcDealClientId,
      stage_id: firstStage.id,
      title: productName,
      amount: price,
      assigned_to: S.user.id,
    }).select().single();
    if (error) throw error;

    await sb.from('deal_items').insert({ deal_id: deal.id, product_id: productId, qty: 1, price });
    await sb.from('interactions').insert({
      client_id: _calcDealClientId, deal_id: deal.id, type: 'system',
      content: `Создана сделка через калькулятор: ${productName} — ${fmtMoney(price)}`, created_by: S.user.id,
    });

    _calcDealClientId = null;
    closeSheet();
    showToast('Сделка создана');
    navigate('deal_detail', { id: deal.id });
  });
}

// ============================================
// ПЕРЕКЛЮЧЕНИЕ ТЕМЫ
// ============================================

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('orthosleep_theme', next);
  render();
}

// ============================================
// ЗАДАЧИ / НАПОМИНАНИЯ
// ============================================

async function renderTasksPage() {
  const { data: tasks, error } = await sb
    .from('tasks')
    .select('*, clients(id,full_name), profiles:assigned_to(full_name)')
    .order('is_done', { ascending: true })
    .order('due_at', { ascending: true, nullsFirst: false });
  if (error) throw error;

  S.cache.allTasks = tasks;
  const active = tasks.filter(t => !t.is_done);
  const done = tasks.filter(t => t.is_done);

  return `
    <div class="page">
      <button class="btn-primary" style="margin-bottom:16px;" onclick="openCreateTaskSheet()">+ Новая задача</button>

      <div class="section-title">Активные (${active.length})</div>
      ${active.length ? active.map(t => renderTaskCard(t)).join('') : `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:14px;">Нет активных задач</div>`}

      ${done.length ? `
        <div class="section-title">Выполнено (${done.length})</div>
        ${done.slice(0, 20).map(t => renderTaskCard(t)).join('')}
      ` : ''}
    </div>
  `;
}

function renderTaskCard(t) {
  const overdue = !t.is_done && t.due_at && new Date(t.due_at) < new Date();
  return `
    <div class="card" style="display:flex;gap:10px;align-items:flex-start;${t.is_done ? 'opacity:0.55;' : ''}">
      <button onclick="toggleTaskDone(${t.id},${!t.is_done})" style="width:22px;height:22px;border-radius:50%;border:2px solid ${t.is_done ? 'var(--accent)' : 'var(--border-light)'};background:${t.is_done ? 'var(--accent)' : 'transparent'};flex-shrink:0;margin-top:1px;color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;">${t.is_done ? '✓' : ''}</button>
      <div style="flex:1;min-width:0;" onclick="openTaskActionsSheet(${t.id})">
        <div style="font-weight:600;font-size:13.5px;${t.is_done ? 'text-decoration:line-through;' : ''}">${escapeHtml(t.title)}</div>
        <div style="font-size:11.5px;color:${overdue ? 'var(--red)' : 'var(--text-dim)'};margin-top:3px;">
          ${t.clients ? escapeHtml(t.clients.full_name) + ' · ' : ''}${t.due_at ? fmtDateTime(t.due_at) : 'без срока'}
          ${overdue ? ' · просрочено' : ''}
          ${t.profiles ? ' · ' + escapeHtml(t.profiles.full_name) : ''}
        </div>
      </div>
    </div>
  `;
}

function openCreateTaskSheet(clientId = null, clientName = null) {
  const userOptions = S.users.map(u => `<option value="${u.id}" ${u.id === S.user.id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`).join('');
  openSheet(`
    <div class="sheet-header"><h3>Новая задача</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Что нужно сделать</label><input type="text" id="new-task-title" placeholder="напр. Позвонить клиенту"></div>
      <div class="field"><label>Срок</label><input type="datetime-local" id="new-task-due"></div>
      <div class="field"><label>Назначить</label><select id="new-task-assignee">${userOptions}</select></div>
      <div class="field">
        <label>Клиент (необязательно)</label>
        <input type="text" id="task-client-search" placeholder="Начни вводить имя или телефон..." value="${clientName ? escapeHtml(clientName) : ''}" oninput="searchClientsForTask(this.value)">
        <div id="task-client-results"></div>
      </div>
      <div id="task-selected-client">${clientName ? `<div style="font-size:12px;color:var(--accent);margin-top:6px;">✓ ${escapeHtml(clientName)}</div>` : ''}</div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreateTask()">Создать задачу</button>
    </div>
  `);
  _taskSelectedClientId = clientId;
}

let _taskSelectedClientId = null;

async function searchClientsForTask(query) {
  const box = document.getElementById('task-client-results');
  if (!query || query.length < 2) { box.innerHTML = ''; return; }
  const { data } = await sb.from('clients').select('id,full_name,phone').or(`full_name.ilike.%${query}%,phone.ilike.%${query}%`).limit(5);
  box.innerHTML = (data || []).map(c => `
    <button class="card" style="width:100%;text-align:left;margin-top:6px;" onclick="selectClientForTask(${c.id},'${escapeHtml(c.full_name).replace(/'/g,"\\'")}')">
      <div style="font-weight:600;font-size:13.5px;">${escapeHtml(c.full_name)}</div>
    </button>
  `).join('') || `<div style="font-size:12px;color:var(--text-faint);padding:8px 0;">Не найдено</div>`;
}

function selectClientForTask(id, name) {
  _taskSelectedClientId = id;
  document.getElementById('task-client-results').innerHTML = '';
  document.getElementById('task-client-search').value = name;
  document.getElementById('task-selected-client').innerHTML = `<div style="font-size:12px;color:var(--accent);margin-top:6px;">✓ ${escapeHtml(name)}</div>`;
}

async function submitCreateTask() {
  const title = document.getElementById('new-task-title').value.trim();
  if (!title) { showToast('Укажи, что нужно сделать', 'error'); return; }
  const dueVal = document.getElementById('new-task-due').value;
  const assignee = document.getElementById('new-task-assignee').value;

  await withLoading(async () => {
    const { error } = await sb.from('tasks').insert({
      title,
      due_at: dueVal ? new Date(dueVal).toISOString() : null,
      assigned_to: assignee || S.user.id,
      client_id: _taskSelectedClientId,
      created_by: S.user.id,
    });
    if (error) throw error;
    _taskSelectedClientId = null;
    closeSheet();
    showToast('Задача создана');
    navigate(S.route === 'tasks' ? 'tasks' : 'dashboard');
  });
}

async function toggleTaskDone(taskId, newDoneState) {
  await withLoading(async () => {
    const { error } = await sb.from('tasks').update({ is_done: newDoneState }).eq('id', taskId);
    if (error) throw error;
    navigate(S.route);
  });
}

function openTaskActionsSheet(taskId) {
  const task = (S.cache.allTasks || []).find(t => t.id === taskId);
  if (!task) { navigate('tasks'); return; }

  const userOptions = S.users.map(u => `<option value="${u.id}" ${task.assigned_to === u.id ? 'selected' : ''}>${escapeHtml(u.full_name)}</option>`).join('');

  openSheet(`
    <div class="sheet-header"><h3>${escapeHtml(task.title)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Что нужно сделать</label><input type="text" id="edit-task-title" value="${escapeHtml(task.title)}"></div>
      <div class="field"><label>Срок</label><input type="datetime-local" id="edit-task-due" value="${task.due_at ? new Date(task.due_at).toISOString().slice(0,16) : ''}"></div>
      <div class="field"><label>Назначено</label><select id="edit-task-assignee">${userOptions}</select></div>
      ${task.clients ? `<div style="font-size:12.5px;color:var(--text-dim);">Клиент: ${escapeHtml(task.clients.full_name)}</div>` : ''}
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditTask(${taskId})">Сохранить</button>
      <button class="btn-secondary" style="margin-top:8px;color:var(--red);" onclick="deleteTask(${taskId})">Удалить задачу</button>
    </div>
  `);
}

async function submitEditTask(taskId) {
  const title = document.getElementById('edit-task-title').value.trim();
  const dueVal = document.getElementById('edit-task-due').value;
  const assignee = document.getElementById('edit-task-assignee').value;

  await withLoading(async () => {
    const { error } = await sb.from('tasks').update({
      title,
      due_at: dueVal ? new Date(dueVal).toISOString() : null,
      assigned_to: assignee,
    }).eq('id', taskId);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate(S.route);
  });
}

async function deleteTask(taskId) {
  if (!confirm('Удалить задачу?')) return;
  await withLoading(async () => {
    const { error } = await sb.from('tasks').delete().eq('id', taskId);
    if (error) throw error;
    closeSheet();
    showToast('Задача удалена');
    navigate('tasks');
  });
}

// ============================================
// АНАЛИТИКА
// ============================================

let _analyticsPeriod = 30; // дней

async function renderAnalytics() {
  return await loadAnalyticsContent(_analyticsPeriod);
}

async function loadAnalyticsContent(days) {
  _analyticsPeriod = days;
  const periodStart = new Date();
  periodStart.setDate(periodStart.getDate() - days);
  periodStart.setHours(0, 0, 0, 0);

  const [dealsRes, ordersRes, itemsRes] = await Promise.all([
    sb.from('deals').select('*, pipeline_stages(name,is_won,is_lost), profiles:assigned_to(full_name)').gte('created_at', periodStart.toISOString()),
    sb.from('orders').select('*').gte('created_at', periodStart.toISOString()),
    sb.from('deal_items').select('qty,price,products(name),deals(created_at)').gte('deals.created_at', periodStart.toISOString()),
  ]);

  const deals = dealsRes.data || [];
  const orders = ordersRes.data || [];
  let items = itemsRes.data || [];
  items = items.filter(i => i.deals); // только связанные с периодом

  const wonDeals = deals.filter(d => d.pipeline_stages?.is_won);
  const lostDeals = deals.filter(d => d.pipeline_stages?.is_lost);
  const revenue = orders.filter(o => o.payment_status === 'paid').reduce((s, o) => s + Number(o.total_amount), 0);
  const pendingRevenue = orders.filter(o => o.payment_status !== 'paid').reduce((s, o) => s + (Number(o.total_amount) - Number(o.paid_amount)), 0);
  const conversion = deals.length ? Math.round((wonDeals.length / deals.length) * 100) : 0;
  const avgCheck = wonDeals.length ? Math.round(wonDeals.reduce((s, d) => s + Number(d.amount), 0) / wonDeals.length) : 0;

  // Топ-товары
  const productStats = {};
  items.forEach(it => {
    const name = it.products?.name || 'Неизвестно';
    if (!productStats[name]) productStats[name] = { qty: 0, revenue: 0 };
    productStats[name].qty += it.qty;
    productStats[name].revenue += it.qty * Number(it.price);
  });
  const topProducts = Object.entries(productStats).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);

  // По менеджерам
  const managerStats = {};
  deals.forEach(d => {
    const name = d.profiles?.full_name || 'Без менеджера';
    if (!managerStats[name]) managerStats[name] = { count: 0, won: 0, revenue: 0 };
    managerStats[name].count++;
    if (d.pipeline_stages?.is_won) {
      managerStats[name].won++;
      managerStats[name].revenue += Number(d.amount);
    }
  });
  const managerList = Object.entries(managerStats).sort((a, b) => b[1].revenue - a[1].revenue);

  // Причины отказов
  const lostReasons = {};
  lostDeals.forEach(d => {
    const reason = d.lost_reason || 'Без причины';
    lostReasons[reason] = (lostReasons[reason] || 0) + 1;
  });

  const maxProductRevenue = topProducts.length ? topProducts[0][1].revenue : 1;
  const maxManagerRevenue = managerList.length ? Math.max(...managerList.map(m => m[1].revenue), 1) : 1;

  return `
    <div class="page">
      <div class="tabs">
        <button class="tab ${days === 7 ? 'active' : ''}" onclick="switchAnalyticsPeriod(7)">7 дней</button>
        <button class="tab ${days === 30 ? 'active' : ''}" onclick="switchAnalyticsPeriod(30)">30 дней</button>
        <button class="tab ${days === 90 ? 'active' : ''}" onclick="switchAnalyticsPeriod(90)">90 дней</button>
      </div>

      <div class="stat-grid">
        <div class="stat-card"><div class="label">💰 Выручка получена</div><div class="value gold">${fmtMoney(revenue)}</div></div>
        <div class="stat-card"><div class="label">⏳ Ожидает оплаты</div><div class="value">${fmtMoney(pendingRevenue)}</div></div>
        <div class="stat-card"><div class="label">📈 Конверсия</div><div class="value">${conversion}%</div><div class="delta">${wonDeals.length} из ${deals.length} сделок</div></div>
        <div class="stat-card"><div class="label">🧾 Средний чек</div><div class="value">${fmtMoney(avgCheck)}</div></div>
      </div>

      <div class="section-title">Воронка</div>
      <div class="card">
        ${S.stages.map(stage => {
          const count = deals.filter(d => d.stage_id === stage.id).length;
          const pct = deals.length ? Math.round((count / deals.length) * 100) : 0;
          return `
            <div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
                <span>${escapeHtml(stage.name)}</span><span style="color:var(--text-dim);">${count}</span>
              </div>
              <div style="height:7px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;">
                <div style="height:100%;width:${pct}%;background:${stage.color};border-radius:6px;"></div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${topProducts.length ? `
        <div class="section-title">Топ товары</div>
        <div class="card">
          ${topProducts.map(([name, stat]) => `
            <div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
                <span>${escapeHtml(name)}</span><span style="color:var(--accent);font-weight:700;">${fmtMoney(stat.revenue)}</span>
              </div>
              <div style="height:7px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;">
                <div style="height:100%;width:${Math.round(stat.revenue / maxProductRevenue * 100)}%;background:var(--accent);border-radius:6px;"></div>
              </div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px;">${stat.qty} шт продано</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${managerList.length ? `
        <div class="section-title">По менеджерам</div>
        <div class="card">
          ${managerList.map(([name, stat]) => `
            <div style="margin-bottom:10px;">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
                <span>${escapeHtml(name)}</span><span style="color:var(--violet);font-weight:700;">${fmtMoney(stat.revenue)}</span>
              </div>
              <div style="height:7px;background:var(--bg-elevated);border-radius:6px;overflow:hidden;">
                <div style="height:100%;width:${Math.round(stat.revenue / maxManagerRevenue * 100)}%;background:var(--violet);border-radius:6px;"></div>
              </div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px;">${stat.count} сделок · ${stat.won} закрыто</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${Object.keys(lostReasons).length ? `
        <div class="section-title">Причины отказов</div>
        <div class="card">
          ${Object.entries(lostReasons).sort((a,b) => b[1]-a[1]).map(([reason, count]) => `
            <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:12.5px;border-bottom:1px solid var(--border);">
              <span>${escapeHtml(reason)}</span><span style="color:var(--red);font-weight:600;">${count}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}

      ${deals.length === 0 ? `<div class="empty-state"><div class="icon">📊</div><div class="title">Нет данных за этот период</div></div>` : ''}
    </div>
  `;
}

async function switchAnalyticsPeriod(days) {
  const container = document.getElementById('main-content');
  container.innerHTML = `<div class="loader-wrap"><div class="spinner"></div></div>`;
  container.innerHTML = await loadAnalyticsContent(days);
}

// ============================================
// ПЕРЕПИСКА (Instagram Direct и в будущем другие каналы)
// ============================================

let _chatClientId = null;
let _chatClientChannel = null; // 'instagram' | 'facebook' | 'whatsapp' — определяет, какую функцию дёргать при отправке
let _chatPollInterval = null;

async function openMessagesSheet(clientId) {
  _chatClientId = clientId;
  const client = (await sb.from('clients').select('full_name,photo_url,instagram_username,facebook_id,whatsapp_number,conversation_owner').eq('id', clientId).single()).data;

  // Определяем канал по тому, какой ID заполнен у клиента (приоритет: instagram > facebook > whatsapp)
  if (client?.instagram_username) _chatClientChannel = 'instagram';
  else if (client?.facebook_id) _chatClientChannel = 'facebook';
  else if (client?.whatsapp_number) _chatClientChannel = 'whatsapp';
  else _chatClientChannel = null;

  const isHumanOwned = client?.conversation_owner === 'human';

  openSheet(`
    <div class="chat-sheet" style="display:flex;flex-direction:column;height:88vh;">
      <div class="sheet-header">
        <div style="display:flex;align-items:center;gap:10px;">
          ${renderAvatar(client?.full_name, client?.photo_url, 32)}
          <h3>${escapeHtml(client?.full_name || 'Переписка')}</h3>
        </div>
        <button class="close-x" onclick="closeChatSheet()">✕</button>
      </div>
      ${isHumanOwned ? `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;background:rgba(232,162,58,0.12);border-bottom:1px solid rgba(232,162,58,0.3);flex-shrink:0;">
          <span style="font-size:12px;color:var(--orange);font-weight:600;">👤 Диалог ведёшь ты — AI на паузе</span>
          <button style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-size:11.5px;font-weight:700;flex-shrink:0;" onclick="returnAiToConversation(${clientId})">Вернуть AI</button>
        </div>
      ` : ''}
      <div class="chat-messages" id="chat-messages-container">
        <div class="loader-wrap"><div class="spinner"></div></div>
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Написать сообщение..." onkeydown="if(event.key==='Enter')sendChatMessage()">
        <button class="chat-send-btn" onclick="sendChatMessage()">➤</button>
      </div>
    </div>
  `, { persistent: true });

  await loadChatMessages(clientId);
  updateInboxUnreadDot(null);

  // Обновляем переписку каждые 8 секунд, пока окно открыто (простой пуллинг без сложной инфраструктуры)
  if (_chatPollInterval) clearInterval(_chatPollInterval);
  _chatPollInterval = setInterval(() => {
    if (document.getElementById('chat-messages-container')) {
      loadChatMessages(clientId, true);
    } else {
      clearInterval(_chatPollInterval);
    }
  }, 8000);
}

/**
 * Если диалог сейчас ведёт человек (AI передал его), сохраняем вопрос клиента и
 * ответ менеджера как обучающий пример — AI увидит его в похожих ситуациях в будущем.
 */
async function saveAiLearningExampleIfNeeded(clientId, managerAnswer) {
  try {
    const { data: client } = await sb.from('clients').select('conversation_owner').eq('id', clientId).single();
    if (client?.conversation_owner !== 'human') return; // обучаем только на реальных "спасательных" ответах

    const { data: lastClientMessage } = await sb
      .from('messages')
      .select('content')
      .eq('client_id', clientId)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastClientMessage) return;

    await sb.from('ai_learning_examples').insert({
      client_question: lastClientMessage.content,
      manager_answer: managerAnswer,
      client_id: clientId,
      created_by: S.user.id,
    });
  } catch (err) {
    console.error('Не удалось сохранить обучающий пример AI:', err);
  }
}

async function returnAiToConversation(clientId) {
  await withLoading(async () => {
    const { error } = await sb.from('clients').update({ conversation_owner: 'ai' }).eq('id', clientId);
    if (error) throw error;

    // Снимаем отметку needs_human_review с последних сообщений, чтобы счётчик "нужен ответ" пропал
    await sb.from('messages').update({ needs_human_review: false }).eq('client_id', clientId).eq('needs_human_review', true);

    await sb.from('interactions').insert({
      client_id: clientId,
      type: 'system',
      content: 'Менеджер вернул диалог AI',
      created_by: S.user.id,
    });

    showToast('AI снова отвечает в этом диалоге');
    openMessagesSheet(clientId);
  });
}

function closeChatSheet() {
  if (_chatPollInterval) clearInterval(_chatPollInterval);
  closeSheet();
  if (S.route === 'inbox') navigate('inbox');
}

async function loadChatMessages(clientId, silent = false) {
  const { data: messages, error } = await sb
    .from('messages')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })
    .limit(200);

  const container = document.getElementById('chat-messages-container');
  if (!container) return;
  if (error) {
    if (!silent) container.innerHTML = `<div class="chat-empty">Не удалось загрузить переписку</div>`;
    return;
  }

  const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;

  if (!messages.length) {
    container.innerHTML = `<div class="chat-empty">Сообщений пока нет.<br>Переписка появится здесь, когда клиент напишет в Instagram.</div>`;
    return;
  }

  container.innerHTML = messages.map(m => `
    <div class="chat-bubble ${m.direction === 'inbound' ? 'inbound' : 'outbound'}">
      ${escapeHtml(m.content)}
      <div class="chat-time">${fmtDateTime(m.created_at)}${m.sender === 'ai_agent' ? ' · 🤖 AI' : ''}</div>
    </div>
  `).join('');

  if (!silent || wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }

  // Помечаем непрочитанные входящие как прочитанные
  const unreadIds = messages.filter(m => m.direction === 'inbound' && !m.is_read).map(m => m.id);
  if (unreadIds.length) {
    const { error: markReadError } = await sb.from('messages').update({ is_read: true }).in('id', unreadIds);
    if (markReadError) {
      console.error('Не удалось пометить сообщения прочитанными:', markReadError);
    } else {
      // Обновляем локальный кэш сразу, чтобы счётчики в инбоксе/точка не мигали до следующей перезагрузки
      messages.forEach(m => { if (unreadIds.includes(m.id)) m.is_read = true; });
      updateInboxUnreadDot(null);
    }
  }
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !_chatClientId) return;

  if (!_chatClientChannel) {
    showToast('У этого клиента нет привязанного канала для отправки', 'error');
    return;
  }

  const functionNameByChannel = {
    instagram: 'instagram-webhook',
    facebook: 'facebook-webhook',
    whatsapp: 'whatsapp-webhook', // будет добавлено на следующем этапе
  };
  const functionName = functionNameByChannel[_chatClientChannel];

  input.value = '';
  input.disabled = true;

  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData.session?.access_token;

    const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}?action=send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ client_id: _chatClientId, text, sender: 'manager' }),
    });
    const data = await res.json();

    if (!data.success) {
      showToast(data.error || 'Не удалось отправить сообщение', 'error');
      input.value = text; // возвращаем текст обратно для повторной попытки
    } else {
      await saveAiLearningExampleIfNeeded(_chatClientId, text);
      await loadChatMessages(_chatClientId);
    }
  } catch (err) {
    showToast('Ошибка отправки', 'error');
    input.value = text;
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// ============================================
// ЕДИНЫЙ ИНБОКС (Instagram + Facebook + WhatsApp)
// ============================================

async function renderInbox() {
  // Берём последнее сообщение по каждому клиенту, у кого есть переписка
  const { data: messages, error } = await sb
    .from('messages')
    .select('*, clients(id,full_name,photo_url,instagram_username,whatsapp_number,facebook_id,conversation_owner), channels(code,name)')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;

  // Группируем по клиенту — оставляем только последнее сообщение каждого
  const byClient = new Map();
  for (const m of messages) {
    if (!m.clients) continue;
    if (!byClient.has(m.client_id)) {
      byClient.set(m.client_id, { lastMessage: m, unreadCount: 0, needsHuman: m.clients.conversation_owner === 'human' });
    }
    if (m.direction === 'inbound' && !m.is_read) {
      byClient.get(m.client_id).unreadCount++;
    }
    if (m.needs_human_review) {
      byClient.get(m.client_id).needsHuman = true;
    }
  }

  const conversations = Array.from(byClient.values()).sort(
    (a, b) => new Date(b.lastMessage.created_at) - new Date(a.lastMessage.created_at)
  );

  updateInboxUnreadDot(conversations);

  if (!conversations.length) {
    return `<div class="page"><div class="empty-state"><div class="icon">💬</div><div class="title">Сообщений пока нет</div><div class="sub">Переписка появится здесь, когда клиенты напишут в Instagram, WhatsApp или Messenger</div></div></div>`;
  }

  const channelIcons = { instagram: '📷', whatsapp: '💚', facebook: '🔵' };

  return `
    <div class="page" style="padding-top:8px;">
      ${conversations.map(({ lastMessage: m, unreadCount, needsHuman }) => `
        <div class="client-row" onclick="openMessagesSheet(${m.clients.id})" style="${needsHuman ? 'border-color:var(--orange);' : (unreadCount > 0 ? 'border-color:var(--violet);' : '')}">
          ${renderAvatar(m.clients.full_name, m.clients.photo_url, 42)}
          <div class="info">
            <div class="name" style="display:flex;align-items:center;gap:6px;">
              ${escapeHtml(m.clients.full_name)}
              <span style="font-size:11px;">${channelIcons[m.channels?.code] || '💬'}</span>
              ${needsHuman ? '<span style="font-size:10px;background:rgba(232,162,58,0.15);color:var(--orange);padding:1px 6px;border-radius:8px;font-weight:700;">нужен ответ</span>' : ''}
            </div>
            <div class="meta" style="display:block;">
              <span style="color:${unreadCount > 0 ? 'var(--text)' : 'var(--text-dim)'};font-weight:${unreadCount > 0 ? '600' : '400'};">${m.direction === 'outbound' ? (m.sender === 'ai_agent' ? '🤖 ' : 'Вы: ') : ''}${escapeHtml((m.content || '').slice(0, 45))}${(m.content || '').length > 45 ? '…' : ''}</span>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:11px;color:var(--text-faint);">${timeAgo(m.created_at)}</div>
            ${unreadCount > 0 ? `<div style="margin-top:4px;background:var(--violet);color:#fff;border-radius:10px;min-width:18px;height:18px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 5px;">${unreadCount}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function updateInboxUnreadDot(conversations) {
  const hasUnread = conversations
    ? conversations.some(c => c.unreadCount > 0)
    : await checkAnyUnreadMessages();
  const dot = document.getElementById('inbox-unread-dot');
  if (dot) dot.style.display = hasUnread ? 'block' : 'none';
}

async function checkAnyUnreadMessages() {
  if (!S.user) return false;
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true }).eq('direction', 'inbound').eq('is_read', false);
  return (count || 0) > 0;
}

// ============================================
// УПРАВЛЕНИЕ AI-АГЕНТОМ
// ============================================

async function renderAiAgentSection() {
  const { data: settings } = await sb.from('ai_agent_settings').select('*').eq('id', 1).maybeSingle();
  const isOn = !!(settings?.is_enabled && settings?.auto_reply_enabled);

  return `
    <div class="section-title">🤖 AI-агент</div>
    <div class="theme-toggle" onclick="toggleAiAgent(${!isOn})">
      <span style="font-weight:600;font-size:13.5px;">${isOn ? 'AI отвечает клиентам автоматически' : 'AI выключен — отвечают только менеджеры'}</span>
      <div class="theme-switch" style="background:${isOn ? 'rgba(0,185,86,0.18)' : 'var(--bg-elevated)'};border-color:${isOn ? 'var(--accent)' : 'var(--border-light)'};">
        <div class="knob" style="left:${isOn ? '26px' : '2px'};background:${isOn ? 'var(--accent)' : 'var(--text-faint)'};"></div>
      </div>
    </div>
    <div style="font-size:11.5px;color:var(--text-faint);margin:-4px 0 14px;padding:0 4px;">
      ${isOn ? 'AI сам отвечает в Instagram/Facebook/WhatsApp, считает цены и создаёт сделки. Сложные случаи передаёт вам.' : 'Включи, чтобы AI начал отвечать клиентам автоматически.'}
    </div>
  `;
}

async function toggleAiAgent(newState) {
  await withLoading(async () => {
    const { error } = await sb.from('ai_agent_settings').update({ is_enabled: newState, auto_reply_enabled: newState }).eq('id', 1);
    if (error) throw error;
    showToast(newState ? 'AI-агент включён' : 'AI-агент выключен');
    navigate('settings');
  });
}

async function toggleClientAiManaged(clientId, newState) {
  await withLoading(async () => {
    const { error } = await sb.from('clients').update({ ai_managed: newState }).eq('id', clientId);
    if (error) throw error;
    showToast(newState ? 'AI снова может отвечать этому клиенту' : 'AI отключён для этого клиента — отвечайте сами');
    navigate('client_detail', { id: clientId });
  });
}

// ============================================
// УПРАВЛЕНИЕ АКЦИЯМИ И БИЗНЕС-ИНФОРМАЦИЕЙ ДЛЯ AI
// ============================================

async function renderAiKnowledge() {
  const [promotionsRes, businessInfoRes, productsRes, settingsRes] = await Promise.all([
    sb.from('promotions').select('*, products(name)').order('created_at', { ascending: false }),
    sb.from('business_info').select('*').order('key'),
    sb.from('products').select('id,name').eq('is_active', true),
    sb.from('ai_agent_settings').select('*').eq('id', 1).maybeSingle(),
  ]);

  const promotions = promotionsRes.data || [];
  const businessInfo = businessInfoRes.data || [];
  const settings = settingsRes.data;
  S.cache.aiKnowledgeProducts = productsRes.data || [];

  const now = new Date();

  return `
    <div class="page">
      <div class="section-title">Личность и стиль продавца</div>
      <div class="card">
        <textarea id="ai-system-prompt" rows="6" placeholder="Опиши, кто такой AI-продавец, какой у него стиль общения...">${escapeHtml(settings?.system_prompt || '')}</textarea>
        <button class="btn-primary" style="margin-top:10px;" onclick="submitSystemPrompt()">Сохранить промпт</button>
        <div style="font-size:11px;color:var(--text-faint);margin-top:8px;">Это базовая инструкция личности AI. Технику продаж, правила про цену и язык AI уже знает автоматически — здесь можно настроить тон, дополнительные правила или особенности именно твоего бизнеса.</div>
      </div>

      <div class="section-title">Акции</div>
      <button class="btn-primary" style="margin-bottom:14px;" onclick="openCreatePromotionSheet()">+ Новая акция</button>
      ${promotions.length ? promotions.map(p => {
        const isActive = p.is_active && new Date(p.starts_at) <= now && new Date(p.ends_at) >= now;
        return `
        <div class="card" onclick="openEditPromotionSheet(${p.id})">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-weight:600;font-size:14px;">${escapeHtml(p.title)}</div>
              <div style="font-size:12px;color:var(--text-dim);margin-top:3px;">${escapeHtml(p.products?.name || 'Все товары')}${p.discount_percent ? ' · скидка ' + p.discount_percent + '%' : ''}</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:3px;">${fmtDate(p.starts_at)} — ${fmtDate(p.ends_at)}</div>
            </div>
            <span class="badge" style="background:${isActive ? 'rgba(0,185,86,0.15)' : 'rgba(0,0,0,0.2)'};color:${isActive ? 'var(--accent)' : 'var(--text-faint)'};">${isActive ? 'Активна' : 'Не активна'}</span>
          </div>
        </div>
      `}).join('') : `<div style="text-align:center;color:var(--text-faint);font-size:12.5px;padding:14px;">Акций пока нет</div>`}

      <div class="section-title">Информация для AI (доставка, оплата, контакты)</div>
      ${businessInfo.map(b => `
        <div class="card" onclick="openEditBusinessInfoSheet('${b.key}')">
          <div style="font-weight:600;font-size:13.5px;">${escapeHtml(b.title)}</div>
          <div style="font-size:12.5px;color:var(--text-dim);margin-top:4px;">${escapeHtml(b.content.slice(0, 100))}${b.content.length > 100 ? '…' : ''}</div>
        </div>
      `).join('')}
      <button class="btn-secondary" style="margin-top:6px;" onclick="openCreateBusinessInfoSheet()">+ Добавить раздел информации</button>
    </div>
  `;
}

async function submitSystemPrompt() {
  const text = document.getElementById('ai-system-prompt').value.trim();
  await withLoading(async () => {
    const { error } = await sb.from('ai_agent_settings').update({ system_prompt: text }).eq('id', 1);
    if (error) throw error;
    showToast('Промпт сохранён');
  });
}

function openCreatePromotionSheet() {
  const productOptions = (S.cache.aiKnowledgeProducts || []).map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  openSheet(`
    <div class="sheet-header"><h3>Новая акция</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название акции</label><input type="text" id="promo-title" placeholder="напр. Летняя распродажа"></div>
      <div class="field"><label>Текст для AI (что говорить клиенту)</label><textarea id="promo-description" rows="3" placeholder="напр. При покупке матраса Sultan — скидка 15% до конца месяца"></textarea></div>
      <div class="field"><label>Скидка, % (необязательно)</label><input type="number" id="promo-discount" placeholder="напр. 15"></div>
      <div class="field"><label>Товар (оставь пустым — акция на всё)</label><select id="promo-product"><option value="">— Все товары —</option>${productOptions}</select></div>
      <div class="field"><label>Дата начала</label><input type="date" id="promo-starts" value="${today}"></div>
      <div class="field"><label>Дата окончания</label><input type="date" id="promo-ends" value="${nextWeek}"></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreatePromotion()">Создать акцию</button>
    </div>
  `);
}

async function submitCreatePromotion() {
  const title = document.getElementById('promo-title').value.trim();
  const description = document.getElementById('promo-description').value.trim();
  if (!title || !description) { showToast('Заполни название и текст акции', 'error'); return; }

  await withLoading(async () => {
    const { error } = await sb.from('promotions').insert({
      title,
      description,
      discount_percent: parseFloat(document.getElementById('promo-discount').value) || null,
      applies_to_product_id: document.getElementById('promo-product').value || null,
      starts_at: document.getElementById('promo-starts').value,
      ends_at: document.getElementById('promo-ends').value + 'T23:59:59',
      is_active: true,
    });
    if (error) throw error;
    closeSheet();
    showToast('Акция создана');
    navigate('ai_knowledge');
  });
}

async function openEditPromotionSheet(promoId) {
  const { data: promo } = await sb.from('promotions').select('*').eq('id', promoId).single();
  if (!promo) return;
  const productOptions = (S.cache.aiKnowledgeProducts || []).map(p => `<option value="${p.id}" ${promo.applies_to_product_id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');

  openSheet(`
    <div class="sheet-header"><h3>Изменить акцию</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название акции</label><input type="text" id="promo-title" value="${escapeHtml(promo.title)}"></div>
      <div class="field"><label>Текст для AI</label><textarea id="promo-description" rows="3">${escapeHtml(promo.description)}</textarea></div>
      <div class="field"><label>Скидка, %</label><input type="number" id="promo-discount" value="${promo.discount_percent || ''}"></div>
      <div class="field"><label>Товар</label><select id="promo-product"><option value="">— Все товары —</option>${productOptions}</select></div>
      <div class="field"><label>Дата начала</label><input type="date" id="promo-starts" value="${promo.starts_at.slice(0,10)}"></div>
      <div class="field"><label>Дата окончания</label><input type="date" id="promo-ends" value="${promo.ends_at.slice(0,10)}"></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditPromotion(${promoId})">Сохранить</button>
      <button class="btn-secondary" style="margin-top:8px;color:var(--red);" onclick="deletePromotion(${promoId})">Удалить акцию</button>
    </div>
  `);
}

async function submitEditPromotion(promoId) {
  await withLoading(async () => {
    const { error } = await sb.from('promotions').update({
      title: document.getElementById('promo-title').value.trim(),
      description: document.getElementById('promo-description').value.trim(),
      discount_percent: parseFloat(document.getElementById('promo-discount').value) || null,
      applies_to_product_id: document.getElementById('promo-product').value || null,
      starts_at: document.getElementById('promo-starts').value,
      ends_at: document.getElementById('promo-ends').value + 'T23:59:59',
    }).eq('id', promoId);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate('ai_knowledge');
  });
}

async function deletePromotion(promoId) {
  if (!confirm('Удалить акцию?')) return;
  await withLoading(async () => {
    const { error } = await sb.from('promotions').delete().eq('id', promoId);
    if (error) throw error;
    closeSheet();
    showToast('Акция удалена');
    navigate('ai_knowledge');
  });
}

function openCreateBusinessInfoSheet() {
  openSheet(`
    <div class="sheet-header"><h3>Новый раздел информации</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Ключ (латиницей, без пробелов)</label><input type="text" id="binfo-key" placeholder="напр. warranty"></div>
      <div class="field"><label>Название раздела</label><input type="text" id="binfo-title" placeholder="напр. Гарантия"></div>
      <div class="field"><label>Текст для AI</label><textarea id="binfo-content" rows="4" placeholder="Что именно должен знать и говорить AI"></textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitCreateBusinessInfo()">Сохранить</button>
    </div>
  `);
}

async function submitCreateBusinessInfo() {
  const key = document.getElementById('binfo-key').value.trim().toLowerCase().replace(/\s+/g, '_');
  const title = document.getElementById('binfo-title').value.trim();
  const content = document.getElementById('binfo-content').value.trim();
  if (!key || !title || !content) { showToast('Заполни все поля', 'error'); return; }

  await withLoading(async () => {
    const { error } = await sb.from('business_info').insert({ key, title, content });
    if (error) throw error;
    closeSheet();
    showToast('Раздел добавлен');
    navigate('ai_knowledge');
  });
}

async function openEditBusinessInfoSheet(key) {
  const { data: info } = await sb.from('business_info').select('*').eq('key', key).single();
  if (!info) return;

  openSheet(`
    <div class="sheet-header"><h3>${escapeHtml(info.title)}</h3><button class="close-x" onclick="closeSheet()">✕</button></div>
    <div class="sheet-body">
      <div class="field"><label>Название раздела</label><input type="text" id="binfo-title" value="${escapeHtml(info.title)}"></div>
      <div class="field"><label>Текст для AI</label><textarea id="binfo-content" rows="5">${escapeHtml(info.content)}</textarea></div>
    </div>
    <div class="sheet-footer">
      <button class="btn-primary" onclick="submitEditBusinessInfo('${key}')">Сохранить</button>
      <button class="btn-secondary" style="margin-top:8px;color:var(--red);" onclick="deleteBusinessInfo('${key}')">Удалить раздел</button>
    </div>
  `);
}

async function submitEditBusinessInfo(key) {
  await withLoading(async () => {
    const { error } = await sb.from('business_info').update({
      title: document.getElementById('binfo-title').value.trim(),
      content: document.getElementById('binfo-content').value.trim(),
      updated_at: new Date().toISOString(),
    }).eq('key', key);
    if (error) throw error;
    closeSheet();
    showToast('Сохранено');
    navigate('ai_knowledge');
  });
}

async function deleteBusinessInfo(key) {
  if (!confirm('Удалить этот раздел информации?')) return;
  await withLoading(async () => {
    const { error } = await sb.from('business_info').delete().eq('key', key);
    if (error) throw error;
    closeSheet();
    showToast('Раздел удалён');
    navigate('ai_knowledge');
  });
}

// ============================================
// ЛОГИ АКТИВНОСТИ
// ============================================

let _activityLogsFilter = 'all';

async function renderActivityLogs() {
  return await loadActivityLogsContent(_activityLogsFilter);
}

async function loadActivityLogsContent(filter) {
  _activityLogsFilter = filter;
  let query = sb.from('activity_logs').select('*, clients(full_name), profiles:actor_id(full_name)').order('created_at', { ascending: false }).limit(150);
  if (filter !== 'all') query = query.eq('category', filter);

  const { data: logs, error } = await query;
  if (error) throw error;

  const categoryConfig = {
    ai: { icon: '🤖', color: 'var(--violet)' },
    manager: { icon: '👤', color: 'var(--accent)' },
    system: { icon: '⚙️', color: 'var(--blue)' },
    error: { icon: '⚠️', color: 'var(--red)' },
  };

  const filterBar = `
    <div class="tabs" style="margin-bottom:14px;">
      <button class="tab ${filter === 'all' ? 'active' : ''}" onclick="switchActivityLogsFilter('all')">Все</button>
      <button class="tab ${filter === 'ai' ? 'active' : ''}" onclick="switchActivityLogsFilter('ai')">🤖 AI</button>
      <button class="tab ${filter === 'manager' ? 'active' : ''}" onclick="switchActivityLogsFilter('manager')">👤 Менеджеры</button>
      <button class="tab ${filter === 'error' ? 'active' : ''}" onclick="switchActivityLogsFilter('error')">⚠️ Ошибки</button>
    </div>
  `;

  if (!logs.length) {
    return `<div class="page">${filterBar}<div class="empty-state"><div class="icon">📋</div><div class="title">Логов пока нет</div></div></div>`;
  }

  return `
    <div class="page">
      ${filterBar}
      ${logs.map(l => {
        const cfg = categoryConfig[l.category] || { icon: '•', color: 'var(--text-dim)' };
        return `
        <div class="timeline-item">
          <div class="timeline-dot" style="background:${cfg.color};"></div>
          <div>
            <div class="txt">${cfg.icon} ${escapeHtml(l.description)}</div>
            <div class="when">${l.profiles?.full_name ? escapeHtml(l.profiles.full_name) + ' · ' : ''}${timeAgo(l.created_at)}</div>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

async function switchActivityLogsFilter(filter) {
  const container = document.getElementById('main-content');
  container.innerHTML = `<div class="loader-wrap"><div class="spinner"></div></div>`;
  container.innerHTML = await loadActivityLogsContent(filter);
}

// ============================================
// БЭКАП И ЭКСПОРТ ДАННЫХ
// ============================================

async function downloadFullBackup() {
  showToast('Готовим бэкап, это может занять немного времени...');
  try {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData.session?.access_token;
    const res = await fetch(`${SUPABASE_URL}/functions/v1/backup-export`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Не удалось создать бэкап');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orthosleep-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Бэкап скачан');
  } catch (err) {
    showToast(err.message || 'Ошибка создания бэкапа', 'error');
  }
}

async function downloadClientsCsv() {
  try {
    const { data: clients, error } = await sb.from('clients').select('*, channels:primary_channel_id(name)').order('created_at', { ascending: false });
    if (error) throw error;

    const headers = ['ID', 'Имя', 'Телефон', 'Instagram', 'WhatsApp', 'Facebook', 'Город', 'Адрес', 'Источник', 'Заметки', 'Дата создания'];
    const rows = clients.map(c => [
      c.id, c.full_name, c.phone || '', c.instagram_username || '', c.whatsapp_number || '', c.facebook_id || '',
      c.city || '', c.address || '', c.channels?.name || '', (c.notes || '').replace(/\n/g, ' '), fmtDate(c.created_at),
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `orthosleep-clients-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Клиенты экспортированы');
  } catch (err) {
    showToast(err.message || 'Ошибка экспорта', 'error');
  }
}

// ============================================
// ЦЕНТР УВЕДОМЛЕНИЙ
// ============================================

async function renderNotifications() {
  const { data: notifications, error } = await sb
    .from('notifications')
    .select('*, clients(id,full_name)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  updateNotificationsUnreadDot(notifications);

  // Помечаем всё прочитанным при открытии страницы
  const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
  if (unreadIds.length) {
    await sb.from('notifications').update({ is_read: true }).in('id', unreadIds);
    updateNotificationsUnreadDot(null);
  }

  if (!notifications.length) {
    return `<div class="page"><div class="empty-state"><div class="icon">🔔</div><div class="title">Уведомлений пока нет</div></div></div>`;
  }

  const typeConfig = {
    new_client: { icon: '👤', label: 'Новый клиент' },
    new_deal: { icon: '🤝', label: 'Новая сделка' },
    ai_escalated: { icon: '🤖', label: 'AI передал диалог' },
    task_overdue: { icon: '⏰', label: 'Просрочена задача' },
    order_paid: { icon: '💰', label: 'Заказ оплачен' },
    low_stock: { icon: '📦', label: 'Мало на складе' },
  };

  return `
    <div class="page">
      ${notifications.map(n => {
        const cfg = typeConfig[n.type] || { icon: '🔔', label: '' };
        return `
        <div class="card" ${n.client_id ? `onclick="navigate('client_detail',{id:${n.client_id}})"` : ''}>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="display:flex;gap:10px;align-items:flex-start;">
              <span style="font-size:18px;">${cfg.icon}</span>
              <div>
                <div style="font-weight:600;font-size:13.5px;">${escapeHtml(n.title)}</div>
                <div style="font-size:11px;color:var(--text-faint);margin-top:3px;">${timeAgo(n.created_at)}</div>
              </div>
            </div>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

async function updateNotificationsUnreadDot(notifications) {
  const hasUnread = notifications
    ? notifications.some(n => !n.is_read)
    : await checkAnyUnreadNotifications();
  const dot = document.getElementById('notif-unread-dot');
  if (dot) dot.style.display = hasUnread ? 'block' : 'none';
}

async function checkAnyUnreadNotifications() {
  if (!S.user) return false;
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false);
  return (count || 0) > 0;
}

import { Hono } from 'hono'
import { listArchiveEntries, verifyArchivePageToken, type ArchiveEntry, type ArchivePlatform } from '../archive'
import { getStore } from '../store'
import { escapeHtml } from '../telegram/i18n'
import type { Env } from '../types'

export const archivePageRoute = new Hono<{ Bindings: Env }>()

const PLATFORM_LABELS: Record<ArchivePlatform, string> = {
  chaturbate: 'Chaturbate',
  tiktok: 'TikTok',
  stripchat: 'Stripchat',
  universal: 'Live',
}

function formatTimestamp(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm} UTC`
}

function renderEntryCard(entry: ArchiveEntry): string {
  const platformLabel = PLATFORM_LABELS[entry.platform] || 'Live'
  const modelSafe = escapeHtml(entry.model)
  const urlSafe = escapeHtml(entry.url)
  const sizeSafe = escapeHtml(entry.size || '—')
  const durationSafe = escapeHtml(entry.duration || '—')
  const timeSafe = escapeHtml(formatTimestamp(entry.createdAt))
  const sourceSafe = entry.source === 'uploader' ? 'احتياطي' : entry.source === 'backfill' ? 'مستورد' : 'مباشر'

  return `<article class="archive-item" data-platform="${escapeHtml(entry.platform)}" data-search="${escapeHtml(`${entry.model} ${entry.platform} ${entry.url}`.toLowerCase())}">
  <div class="col-model">
    <span class="badge badge-${escapeHtml(entry.platform)}">${escapeHtml(platformLabel)}</span>
    <code class="model-name" dir="ltr">${modelSafe}</code>
  </div>
  <div class="col-meta tabular">${sizeSafe}</div>
  <div class="col-meta tabular">${durationSafe}</div>
  <div class="col-meta tabular">${timeSafe} <span class="source-note">(${escapeHtml(sourceSafe)})</span></div>
  <div class="col-actions">
    <a class="btn btn-primary" href="${urlSafe}" target="_blank" rel="noopener noreferrer">فتح البث</a>
    <button type="button" class="btn btn-secondary copy-btn" data-url="${urlSafe}">نسخ الرابط</button>
  </div>
</article>`
}

function renderArchiveHtml(entries: ArchiveEntry[]): string {
  const counts: Record<string, number> = { all: entries.length, chaturbate: 0, tiktok: 0, stripchat: 0 }
  for (const entry of entries) {
    counts[entry.platform] = (counts[entry.platform] || 0) + 1
  }

  const rowsHtml = entries.map(renderEntryCard).join('\n')

  return `<!doctype html>
<html lang="ar" dir="rtl" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>أرشيف التسجيلات — SaveLink</title>
  <style>
    :root {
      --bg: #0f1419;
      --surface: #182028;
      --surface-alt: #202a35;
      --border: #2e3b48;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #0369a1;
      --accent-hover: #0284c7;
      --link: #38bdf8;
      --cb-bg: #991b1b;
      --tt-bg: #0f766e;
      --sc-bg: #6b21a8;
      --live-bg: #334155;
      --focus: #38bdf8;
    }
    html[data-theme="light"] {
      --bg: #f8fafc;
      --surface: #ffffff;
      --surface-alt: #f1f5f9;
      --border: #cbd5e1;
      --text: #0f172a;
      --muted: #475569;
      --accent: #0369a1;
      --accent-hover: #0284c7;
      --link: #0369a1;
      --cb-bg: #991b1b;
      --tt-bg: #0f766e;
      --sc-bg: #6b21a8;
      --live-bg: #334155;
      --focus: #0369a1;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, "Segoe UI", Tahoma, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      font-size: clamp(0.9375rem, 0.9rem + 0.25vw, 1rem);
    }
    .wrap {
      max-width: 72rem;
      margin: 0 auto;
      padding: clamp(1rem, 2.5vw, 2rem) clamp(0.875rem, 2vw, 1.5rem);
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    h1 {
      margin: 0;
      font-size: clamp(1.25rem, 1.1rem + 0.8vw, 1.75rem);
      font-weight: 700;
    }
    .subtitle {
      margin: 0.25rem 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }
    .tabular { font-variant-numeric: tabular-nums; }
    .controls {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.75rem;
      margin: 1rem 0;
    }
    @media (min-width: 48rem) {
      .controls {
        grid-template-columns: minmax(14rem, 22rem) 1fr;
        align-items: center;
      }
    }
    .search-input {
      width: 100%;
      min-height: 2.75rem;
      padding: 0.5rem 0.875rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      background: var(--surface);
      color: var(--text);
      font-size: 0.95rem;
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .filter-btn, .theme-btn {
      min-height: 2.75rem;
      padding: 0.45rem 0.85rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      background: var(--surface);
      color: var(--text);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .filter-btn[aria-pressed="true"] {
      background: var(--accent);
      border-color: var(--accent);
      color: #ffffff;
    }
    .table-head {
      display: none;
    }
    .archive-list {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.75rem;
    }
    @media (min-width: 40rem) {
      .archive-list {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .archive-item {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.625rem;
      padding: 0.875rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }
    .col-model {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .model-name {
      font-size: 0.98rem;
      font-weight: 700;
      word-break: break-all;
    }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 700;
      color: #ffffff;
    }
    .badge-chaturbate { background: var(--cb-bg); }
    .badge-tiktok { background: var(--tt-bg); }
    .badge-stripchat { background: var(--sc-bg); }
    .badge-universal { background: var(--live-bg); }
    .col-meta {
      color: var(--muted);
      font-size: 0.875rem;
    }
    .source-note { font-size: 0.8rem; }
    .col-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.25rem;
    }
    @media (min-width: 64rem) {
      .table-head {
        display: grid;
        grid-template-columns: 1.5fr 0.7fr 0.7fr 1.25fr 1.25fr;
        gap: 0.75rem;
        padding: 0.65rem 1rem;
        background: var(--surface-alt);
        border: 1px solid var(--border);
        border-radius: 0.625rem 0.625rem 0 0;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
      }
      .archive-list {
        grid-template-columns: 1fr;
        gap: 0;
      }
      .archive-item {
        display: grid;
        grid-template-columns: 1.5fr 0.7fr 0.7fr 1.25fr 1.25fr;
        align-items: center;
        gap: 0.75rem;
        border-radius: 0;
        border-top: 0;
        padding: 0.75rem 1rem;
      }
      .archive-item:last-child {
        border-radius: 0 0 0.625rem 0.625rem;
      }
      .col-actions {
        margin-top: 0;
        justify-content: flex-end;
      }
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      padding: 0.45rem 0.9rem;
      border-radius: 0.45rem;
      font-size: 0.875rem;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
      border: 1px solid transparent;
    }
    .btn-primary {
      background: var(--accent);
      color: #ffffff;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary {
      background: var(--surface-alt);
      border-color: var(--border);
      color: var(--text);
    }
    .empty-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 0.625rem;
      padding: 2rem 1rem;
      text-align: center;
      color: var(--muted);
    }
    .hidden { display: none !important; }
    a:focus-visible, button:focus-visible, input:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="topbar">
      <div>
        <h1>أرشيف روابط التسجيل</h1>
        <p class="subtitle tabular">الإجمالي المحفوظ: <strong id="visibleCount">${entries.length}</strong> / ${entries.length} تسجيلاً</p>
      </div>
      <button type="button" id="themeToggle" class="theme-btn">تبديل المظهر</button>
    </header>

    <section class="controls" aria-label="تصفية التسجيلات">
      <input id="searchInput" class="search-input" type="search" placeholder="ابحث باسم الحساب أو الرابط..." aria-label="ابحث باسم الحساب أو الرابط">
      <div class="filters" role="group" aria-label="فلترة المنصة">
        <button type="button" class="filter-btn tabular" data-filter="all" aria-pressed="true">الكل (${counts.all})</button>
        <button type="button" class="filter-btn tabular" data-filter="chaturbate" aria-pressed="false">Chaturbate (${counts.chaturbate})</button>
        <button type="button" class="filter-btn tabular" data-filter="tiktok" aria-pressed="false">TikTok (${counts.tiktok})</button>
        <button type="button" class="filter-btn tabular" data-filter="stripchat" aria-pressed="false">Stripchat (${counts.stripchat})</button>
      </div>
    </section>

    <div class="table-head" aria-hidden="true">
      <span>الحساب والمنصة</span>
      <span>الحجم</span>
      <span>المدة</span>
      <span>التاريخ</span>
      <span>الروابط</span>
    </div>

    <section id="archiveList" class="archive-list" aria-live="polite">
      ${rowsHtml}
    </section>

    <div id="emptyBox" class="empty-box ${entries.length ? 'hidden' : ''}">
      لا توجد تسجيلات مطابقة حالياً. كل تسجيل يكتمل أو يتوقف يُحفظ رابطه هنا تلقائياً.
    </div>
  </main>

  <script>
    (function () {
      var root = document.documentElement;
      var savedTheme = localStorage.getItem('savelink_archive_theme');
      if (savedTheme === 'light' || savedTheme === 'dark') root.setAttribute('data-theme', savedTheme);

      var themeBtn = document.getElementById('themeToggle');
      function syncThemeLabel() {
        themeBtn.textContent = root.getAttribute('data-theme') === 'light' ? 'الوضع الداكن' : 'الوضع الفاتح';
      }
      syncThemeLabel();
      themeBtn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        root.setAttribute('data-theme', next);
        localStorage.setItem('savelink_archive_theme', next);
        syncThemeLabel();
      });

      var activeFilter = 'all';
      var searchInput = document.getElementById('searchInput');
      var items = Array.prototype.slice.call(document.querySelectorAll('.archive-item'));
      var filterBtns = Array.prototype.slice.call(document.querySelectorAll('.filter-btn'));
      var visibleCount = document.getElementById('visibleCount');
      var emptyBox = document.getElementById('emptyBox');

      function applyFilters() {
        var needle = (searchInput.value || '').trim().toLowerCase();
        var shown = 0;
        items.forEach(function (el) {
          var plat = el.getAttribute('data-platform') || '';
          var hay = el.getAttribute('data-search') || '';
          var okPlat = activeFilter === 'all' || plat === activeFilter;
          var okText = !needle || hay.indexOf(needle) !== -1;
          var visible = okPlat && okText;
          el.classList.toggle('hidden', !visible);
          if (visible) shown++;
        });
        visibleCount.textContent = String(shown);
        emptyBox.classList.toggle('hidden', shown > 0);
      }

      searchInput.addEventListener('input', applyFilters);
      filterBtns.forEach(function (btn) {
        btn.addEventListener('click', function () {
          activeFilter = btn.getAttribute('data-filter') || 'all';
          filterBtns.forEach(function (b) {
            b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
          });
          applyFilters();
        });
      });

      document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.copy-btn') : null;
        if (!btn) return;
        var url = btn.getAttribute('data-url') || '';
        if (!url || !navigator.clipboard) return;
        navigator.clipboard.writeText(url).then(function () {
          var prev = btn.textContent;
          btn.textContent = 'تم النسخ';
          setTimeout(function () { btn.textContent = prev; }, 1500);
        }).catch(function () {});
      });
    })();
  </script>
</body>
</html>`
}

archivePageRoute.get('/', async (c) => {
  const token = c.req.query('t') || ''
  const verified = await verifyArchivePageToken(token, c.env)
  if (!verified) {
    return c.html(
      `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>رابط منتهي</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,Tahoma,sans-serif;background:#0f1419;color:#f1f5f9;padding:1.5rem}main{max-width:28rem;padding:1.5rem;border:1px solid #2e3b48;border-radius:.75rem;background:#182028;text-align:center}code{background:#202a35;padding:.15rem .4rem;border-radius:.3rem}</style></head><body><main><h1>الرابط غير صالح أو منتهي الصلاحية</h1><p>أرسل <code>/archive</code> في بوت تيليجرام للحصول على رابط جديد.</p></main></body></html>`,
      401,
    )
  }

  const store = getStore(c.env)
  const entries = await listArchiveEntries(store, verified.chatId)
  return c.html(renderArchiveHtml(entries))
})

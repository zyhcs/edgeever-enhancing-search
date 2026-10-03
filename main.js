/**
 * EdgeEver Enhancing Search Plugin
 * 全库增强搜索 (Enhanced Global Search)
 *
 * 核心功能：
 * 1. 突破单笔记/单笔记本限制，支持全库所有笔记的全文与元数据深度检索；
 * 2. 多维度筛选：关键词多词分词、#标签过滤、创建时间/修改时间区间过滤；
 * 3. 智能权重评分与匹配高亮上下文摘录 (Smart Snippets)；
 * 4. 现代 Spotlight 双栏即时卡片预览与无缝跳转；
 * 5. 自动集成至右下角统一插件工具坞 (Plugin Dock)，绝不遮挡其他插件。
 */

// ==================== 1. 工具函数与时间处理 ====================

function debounce(fn, wait = 100) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDate(isoOrTs) {
  if (!isoOrTs) return "-";
  try {
    const d = new Date(isoOrTs);
    if (isNaN(d.getTime())) return String(isoOrTs);
    const pad = (n) => String(n).padStart(2, "0");
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hour = pad(d.getHours());
    const min = pad(d.getMinutes());
    return `${year}-${month}-${day} ${hour}:${min}`;
  } catch (e) {
    return String(isoOrTs);
  }
}

function formatRelativeTime(isoOrTs) {
  if (!isoOrTs) return "";
  try {
    const d = new Date(isoOrTs);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    if (diffDay === 0) {
      if (diffHour === 0) {
        if (diffMin <= 1) return "刚刚";
        return `${diffMin}分钟前`;
      }
      return `${diffHour}小时前`;
    }
    if (diffDay === 1) return "昨天";
    if (diffDay < 7) return `${diffDay}天前`;
    if (diffDay < 30) return `${Math.floor(diffDay / 7)}周前`;
    if (diffDay < 365) return `${Math.floor(diffDay / 30)}个月前`;
    return `${Math.floor(diffDay / 365)}年前`;
  } catch (e) {
    return "";
  }
}

/**
 * 简易 Markdown 转纯文本
 */
function stripMarkdown(md) {
  if (!md) return "";
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#+\s+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~>]/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 简易 Markdown 转安全 HTML（用于右侧即时卡片预览）
 */
function renderMarkdownPreviewHtml(md, keywords = []) {
  if (!md) return "<p style='color: var(--ee-search-text-muted);'>（暂无正文内容）</p>";

  const lines = md.split(/\r?\n/);
  let html = "";
  let inCode = false;
  let inUl = false;

  for (let line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCode) {
        html += "</code></pre>";
        inCode = false;
      } else {
        html += "<pre><code>";
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      html += escapeHtml(line) + "\n";
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (!inUl) {
        html += "<ul>";
        inUl = true;
      }
      html += `<li>${escapeHtml(trimmed.slice(2))}</li>`;
      continue;
    } else if (inUl) {
      html += "</ul>";
      inUl = false;
    }

    if (trimmed.startsWith("### ")) {
      html += `<h3>${escapeHtml(trimmed.slice(4))}</h3>`;
    } else if (trimmed.startsWith("## ")) {
      html += `<h2>${escapeHtml(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith("# ")) {
      html += `<h1>${escapeHtml(trimmed.slice(2))}</h1>`;
    } else if (trimmed.startsWith("> ")) {
      html += `<blockquote>${escapeHtml(trimmed.slice(2))}</blockquote>`;
    } else if (trimmed.length > 0) {
      html += `<p>${escapeHtml(trimmed)}</p>`;
    }
  }

  if (inUl) html += "</ul>";
  if (inCode) html += "</code></pre>";

  // 高亮关键词
  if (keywords && keywords.length > 0) {
    for (const kw of keywords) {
      if (!kw || kw.length < 1) continue;
      const re = new RegExp(`(${escapeRegExp(escapeHtml(kw))})`, "gi");
      html = html.replace(re, '<mark class="ee-search-hl">$1</mark>');
    }
  }

  return html;
}

// ==================== 2. 全库笔记获取与检索引擎 ====================

class EnhancedSearchEngine {
  constructor(context) {
    this.context = context;
    this.cachedNotes = [];
    this.lastIndexedAt = 0;
    this.isIndexing = false;
  }

  /**
   * 分批全量拉取整个应用中的所有笔记
   */
  async fetchAllNotes(force = false) {
    const now = Date.now();
    // 缓存 30 秒有效
    if (!force && this.cachedNotes.length > 0 && now - this.lastIndexedAt < 30000) {
      return this.cachedNotes;
    }

    if (this.isIndexing) {
      return this.cachedNotes;
    }

    this.isIndexing = true;
    const allNotes = [];
    const limit = 100;
    let offset = 0;
    let maxPages = 15; // 保护上限支持达 1500 篇

    try {
      while (maxPages-- > 0) {
        let res = null;
        try {
          res = await this.context.notes.query({
            limit: limit,
            offset: offset,
          });
        } catch (e) {
          // 部分老版本 API 不支持 offset，降级直接单次 query
          res = await this.context.notes.query({ limit: 100 });
        }

        const list = Array.isArray(res) ? res : res?.notes || [];
        if (!list || list.length === 0) break;

        for (const item of list) {
          if (!item || !item.id) continue;
          const excerptText = item.excerpt || item.contentText || "";
          const rawMd = item.contentMarkdown || item.content || item.body || "";
          allNotes.push({
            id: item.id,
            title: (item.title || "").trim() || "无标题笔记",
            excerpt: excerptText,
            contentMarkdown: rawMd,
            plainText: stripMarkdown(rawMd) || excerptText,
            tags: Array.isArray(item.tags) ? item.tags : [],
            notebookId: item.notebookId || item.notebook_id || "",
            notebookName: item.notebookName || item.notebook?.name || "默认笔记本",
            createdAt: item.createdAt || item.created_at || Date.now(),
            updatedAt: item.updatedAt || item.updated_at || item.createdAt || Date.now(),
          });
        }

        if (list.length < limit) break;
        offset += limit;
      }

      this.cachedNotes = allNotes;
      this.lastIndexedAt = Date.now();
    } catch (err) {
      console.error("[Enhancing Search] 全量获取笔记异常:", err);
    } finally {
      this.isIndexing = false;
    }

    return this.cachedNotes;
  }

  /**
   * 异步拉取单篇笔记完整 Markdown 正文并缓存
   */
  async getFullNote(noteId) {
    if (!noteId) return null;
    const cached = this.cachedNotes.find((n) => n.id === noteId);
    if (cached && cached.contentMarkdown && cached.contentMarkdown.length > 0) {
      return cached;
    }

    try {
      const full = await this.context.notes.get(noteId);
      if (full) {
        const md = full.contentMarkdown || full.content || "";
        const pt = stripMarkdown(md) || full.excerpt || full.contentText || "";
        if (cached) {
          cached.contentMarkdown = md;
          cached.plainText = pt;
          if (full.notebookName) cached.notebookName = full.notebookName;
          if (full.tags && Array.isArray(full.tags)) cached.tags = full.tags;
          return cached;
        }
        return {
          id: full.id,
          title: (full.title || "").trim() || "无标题笔记",
          contentMarkdown: md,
          plainText: pt,
          tags: full.tags || [],
          notebookId: full.notebookId || "",
          notebookName: full.notebookName || "默认笔记本",
          createdAt: full.createdAt,
          updatedAt: full.updatedAt,
        };
      }
    } catch (e) {
      console.warn("[Enhancing Search] getFullNote 异常:", e);
    }
    return cached;
  }

  /**
   * 智能上下文片段生成器 (Smart Snippet Snipper)
   */
  generateSnippet(plainText, keywords) {
    if (!plainText) return "（暂无正文内容）";
    if (!keywords || keywords.length === 0) {
      return escapeHtml(plainText.slice(0, 110)) + (plainText.length > 110 ? "..." : "");
    }

    // 寻找第一个命中关键词的位置
    let firstIndex = -1;
    let matchKeyword = "";
    const lowerText = plainText.toLowerCase();

    for (const kw of keywords) {
      const idx = lowerText.indexOf(kw.toLowerCase());
      if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
        firstIndex = idx;
        matchKeyword = kw;
      }
    }

    let snippet = "";
    if (firstIndex === -1) {
      snippet = plainText.slice(0, 110);
    } else {
      const start = Math.max(0, firstIndex - 45);
      const end = Math.min(plainText.length, firstIndex + matchKeyword.length + 65);
      snippet = (start > 0 ? "..." : "") + plainText.slice(start, end) + (end < plainText.length ? "..." : "");
    }

    let safeSnippet = escapeHtml(snippet);
    for (const kw of keywords) {
      if (!kw) continue;
      const re = new RegExp(`(${escapeRegExp(escapeHtml(kw))})`, "gi");
      safeSnippet = safeSnippet.replace(re, '<mark class="ee-search-hl">$1</mark>');
    }

    return safeSnippet;
  }

  /**
   * 复合多条件搜索与打分过滤
   */
  search(notes, options = {}) {
    const rawQuery = (options.query || "").trim();
    const dateRange = options.dateRange || "all"; // all, today, week, month, year
    const dateField = options.dateField || "updated"; // updated, created
    const sortMode = options.sortMode || "relevance"; // relevance, updated_desc, created_desc, title_asc
    const selectedTag = options.selectedTag || "";

    // 1. 解析查询语法（分离关键词与标签语法，例如输入: "#前端 react hooks"）
    let tagFilters = [];
    if (selectedTag) {
      tagFilters.push(selectedTag.toLowerCase());
    }

    const queryKeywords = [];
    const tokens = rawQuery.split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      if (token.startsWith("#") && token.length > 1) {
        tagFilters.push(token.slice(1).toLowerCase());
      } else {
        queryKeywords.push(token);
      }
    }

    // 2. 时间过滤阈值计算
    const now = Date.now();
    let minTime = 0;
    if (dateRange === "today") {
      minTime = now - 24 * 60 * 60 * 1000;
    } else if (dateRange === "week") {
      minTime = now - 7 * 24 * 60 * 60 * 1000;
    } else if (dateRange === "month") {
      minTime = now - 30 * 24 * 60 * 60 * 1000;
    } else if (dateRange === "year") {
      minTime = now - 365 * 24 * 60 * 60 * 1000;
    }

    const results = [];

    for (const note of notes) {
      // 时间过滤
      const targetTimeVal = dateField === "created" ? new Date(note.createdAt).getTime() : new Date(note.updatedAt).getTime();
      if (minTime > 0 && targetTimeVal < minTime) {
        continue;
      }

      // 标签过滤
      if (tagFilters.length > 0) {
        const noteTagsLower = note.tags.map((t) => String(t).toLowerCase());
        const hasAllTags = tagFilters.every((tf) => noteTagsLower.some((nt) => nt.includes(tf)));
        if (!hasAllTags) {
          continue;
        }
      }

      // 关键词匹配与评分计算
      let score = 0;
      const lowerTitle = note.title.toLowerCase();
      const lowerPlain = note.plainText.toLowerCase();

      if (queryKeywords.length > 0) {
        let allKeywordsMatch = true;

        for (const kw of queryKeywords) {
          const lkw = kw.toLowerCase();
          const inTitle = lowerTitle.includes(lkw);
          const inBody = lowerPlain.includes(lkw);
          const inTags = note.tags.some((t) => String(t).toLowerCase().includes(lkw));

          if (!inTitle && !inBody && !inTags) {
            allKeywordsMatch = false;
            break;
          }

          if (inTitle) {
            score += 60;
            if (lowerTitle === lkw) score += 40;
          }
          if (inTags) {
            score += 35;
          }
          if (inBody) {
            score += 15;
            // 简单频率奖励
            const count = (lowerPlain.match(new RegExp(escapeRegExp(lkw), "g")) || []).length;
            score += Math.min(25, count * 3);
          }
        }

        if (!allKeywordsMatch) {
          continue;
        }
      } else {
        // 无关键词时，只要符合标签与时间即算命中
        score = 1;
      }

      // 时间加成（近7天编辑轻微加权，使得同分近期的排前面）
      const ageDays = (now - targetTimeVal) / (1000 * 60 * 60 * 24);
      if (ageDays < 7) score += 5;

      results.push({
        ...note,
        score,
        snippet: this.generateSnippet(note.plainText, queryKeywords),
      });
    }

    // 3. 排序规则应用
    results.sort((a, b) => {
      if (sortMode === "relevance") {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (sortMode === "updated_desc") {
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      }
      if (sortMode === "created_desc") {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (sortMode === "title_asc") {
        return a.title.localeCompare(b.title, "zh-CN");
      }
      return 0;
    });

    return {
      results,
      queryKeywords,
      totalCount: results.length,
    };
  }
}

// ==================== 3. 搜索弹窗与双栏卡片交互界面 ====================

let activeModal = null;

function openSearchModal(context, engine) {
  if (activeModal) {
    try {
      activeModal.remove();
    } catch (e) {}
    activeModal = null;
  }

  const backdrop = document.createElement("div");
  backdrop.className = "edgeever-search-backdrop";

  // 状态变量
  let currentNotes = [];
  let currentResults = [];
  let selectedIndex = 0;
  let activeKeywords = [];
  let dateRange = "all";
  let dateField = "updated";
  let sortMode = "relevance";
  let selectedTag = "";

  backdrop.innerHTML = `
    <div class="edgeever-search-modal" role="dialog" aria-modal="true">
      <!-- 顶部搜索输入与过滤工具栏 -->
      <div class="edgeever-search-header">
        <div class="edgeever-search-input-wrap">
          <div class="edgeever-search-input-icon">
            <svg viewBox="0 0 24 24">
              <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </div>
          <input 
            type="text" 
            class="edgeever-search-input" 
            placeholder="全库增强搜索：输入关键字、#标签、按时间快速筛选..." 
            autofocus 
          />
          <button type="button" class="edgeever-search-clear-btn" title="清空搜索内容" style="display: none;">
            <svg viewBox="0 0 24 24">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
          <span class="edgeever-search-shortcut-badge">ESC 退出</span>
        </div>

        <div class="edgeever-search-filter-bar">
          <div class="edgeever-search-filter-left">
            <button type="button" class="edgeever-filter-pill is-active" data-range="all">全部时间</button>
            <button type="button" class="edgeever-filter-pill" data-range="today">今天</button>
            <button type="button" class="edgeever-filter-pill" data-range="week">最近7天</button>
            <button type="button" class="edgeever-filter-pill" data-range="month">最近30天</button>

            <!-- 时间基准 -->
            <select class="edgeever-filter-select" id="ee-search-date-field" title="切换筛选时间基准">
              <option value="updated">🕒 按修改时间</option>
              <option value="created">📅 按创建时间</option>
            </select>
          </div>

          <div class="edgeever-search-filter-right">
            <!-- 排序方式 -->
            <select class="edgeever-filter-select" id="ee-search-sort-mode" title="搜索结果排序规则">
              <option value="relevance">🎯 智能相关度优先</option>
              <option value="updated_desc">🕒 最近修改时间</option>
              <option value="created_desc">📅 最新创建时间</option>
              <option value="title_asc">🔤 标题字典顺序</option>
            </select>
            <button type="button" class="edgeever-filter-pill" id="ee-search-refresh-btn" title="强制重新拉取最新笔记索引">
              🔄 刷新索引
            </button>
          </div>
        </div>
      </div>

      <!-- 双栏核心内容视口 -->
      <div class="edgeever-search-main">
        <!-- 左栏：卡片结果列表 -->
        <div class="edgeever-search-results-pane">
          <div class="edgeever-search-stats-bar">
            <span id="ee-search-stats-text">正在检索全库笔记...</span>
            <span id="ee-search-time-cost" style="color: var(--ee-search-primary); font-weight: 500;"></span>
          </div>
          <div class="edgeever-search-cards-list" id="ee-search-list-container">
            <!-- 动态卡片 -->
          </div>
        </div>

        <!-- 右栏：即时卡片深度预览 -->
        <div class="edgeever-search-preview-pane">
          <div class="edgeever-search-preview-header">
            <div class="edgeever-search-preview-title-wrap">
              <div class="edgeever-search-preview-title" id="ee-preview-title">请选择左侧笔记</div>
              <div class="edgeever-search-preview-subtitle" id="ee-preview-subtitle">即时深度卡片预览与快速定位</div>
            </div>
            <div class="edgeever-search-preview-actions">
              <button type="button" class="edgeever-preview-action-btn is-primary" id="ee-preview-open-btn">
                🚀 立即在编辑器中打开 (Enter)
              </button>
            </div>
          </div>

          <div class="edgeever-search-preview-body" id="ee-preview-body">
            <div class="edgeever-search-empty-state">
              <div class="edgeever-search-empty-icon">
                <svg viewBox="0 0 24 24">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
              </div>
              <div class="edgeever-search-empty-title">在左侧选择笔记以快速预览</div>
              <div class="edgeever-search-empty-desc">支持全文字段高亮、标签显示与一键定位打开</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部状态与快捷键提示 -->
      <div class="edgeever-search-footer">
        <div class="edgeever-search-shortcuts">
          <span class="edgeever-search-shortcut-item"><kbd>↑</kbd> <kbd>↓</kbd> 切换卡片</span>
          <span class="edgeever-search-shortcut-item"><kbd>Enter</kbd> 立即打开</span>
          <span class="edgeever-search-shortcut-item"><kbd>Esc</kbd> 关闭面板</span>
          <span class="edgeever-search-shortcut-item"><kbd>#tag</kbd> 快速筛选标签</span>
        </div>
        <div class="edgeever-search-index-status">
          <div class="edgeever-search-status-dot"></div>
          <span id="ee-search-cached-count">全库就绪</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  activeModal = backdrop;

  const inputEl = backdrop.querySelector(".edgeever-search-input");
  const clearBtn = backdrop.querySelector(".edgeever-search-clear-btn");
  const listContainer = backdrop.querySelector("#ee-search-list-container");
  const statsTextEl = backdrop.querySelector("#ee-search-stats-text");
  const timeCostEl = backdrop.querySelector("#ee-search-time-cost");
  const cachedCountEl = backdrop.querySelector("#ee-search-cached-count");
  const previewTitleEl = backdrop.querySelector("#ee-preview-title");
  const previewSubtitleEl = backdrop.querySelector("#ee-preview-subtitle");
  const previewBodyEl = backdrop.querySelector("#ee-preview-body");
  const previewOpenBtn = backdrop.querySelector("#ee-preview-open-btn");
  const dateFieldSelect = backdrop.querySelector("#ee-search-date-field");
  const sortModeSelect = backdrop.querySelector("#ee-search-sort-mode");
  const refreshBtn = backdrop.querySelector("#ee-search-refresh-btn");

  // 关闭逻辑
  function closeModal() {
    backdrop.style.opacity = "0";
    backdrop.style.transition = "opacity 0.15s ease";
    setTimeout(() => {
      try {
        backdrop.remove();
      } catch (e) {}
      if (activeModal === backdrop) activeModal = null;
    }, 150);
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });

  // 渲染右侧卡片深度预览
  function renderPreview(note) {
    if (!note) {
      previewTitleEl.textContent = "无匹配结果";
      previewSubtitleEl.textContent = "";
      previewBodyEl.innerHTML = `
        <div class="edgeever-search-empty-state">
          <div class="edgeever-search-empty-title">未找到匹配的笔记</div>
          <div class="edgeever-search-empty-desc">尝试更换关键字、去除筛选条件或点击“刷新索引”</div>
        </div>
      `;
      previewOpenBtn.style.display = "none";
      return;
    }

    previewOpenBtn.style.display = "inline-flex";
    previewTitleEl.textContent = note.title;
    previewSubtitleEl.textContent = `所属笔记本：${note.notebookName} • 更新于 ${formatRelativeTime(note.updatedAt)}`;

    const tagsHtml = note.tags && note.tags.length > 0
      ? note.tags.map((t) => `<span class="edgeever-meta-tag is-user-tag">#${escapeHtml(t)}</span>`).join(" ")
      : "<span style='color: var(--ee-search-text-muted); font-size: 12px;'>（无标签）</span>";

    const wordCount = (note.plainText || note.excerpt || "").length;

    const renderMetaAndBody = (targetNote) => {
      const actualCount = (targetNote.plainText || targetNote.excerpt || "").length;
      const metaGridHtml = `
        <div class="edgeever-preview-meta-grid">
          <div class="edgeever-preview-meta-item">
            <span class="edgeever-preview-meta-label">所属笔记本</span>
            <span class="edgeever-preview-meta-value">${escapeHtml(targetNote.notebookName)}</span>
          </div>
          <div class="edgeever-preview-meta-item">
            <span class="edgeever-preview-meta-label">最后修改时间</span>
            <span class="edgeever-preview-meta-value">${formatDate(targetNote.updatedAt)}</span>
          </div>
          <div class="edgeever-preview-meta-item">
            <span class="edgeever-preview-meta-label">创建时间</span>
            <span class="edgeever-preview-meta-value">${formatDate(targetNote.createdAt)}</span>
          </div>
          <div class="edgeever-preview-meta-item">
            <span class="edgeever-preview-meta-label">正文字符数</span>
            <span class="edgeever-preview-meta-value">${actualCount} 字</span>
          </div>
          <div class="edgeever-preview-meta-item" style="grid-column: 1 / -1;">
            <span class="edgeever-preview-meta-label">关联标签</span>
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
              ${tagsHtml}
            </div>
          </div>
        </div>
      `;

      const contentToRender = targetNote.contentMarkdown || targetNote.excerpt || "";
      const bodyHtml = renderMarkdownPreviewHtml(contentToRender, activeKeywords);

      previewBodyEl.innerHTML = `
        ${metaGridHtml}
        <div class="edgeever-preview-markdown">
          ${bodyHtml}
        </div>
      `;
    };

    // 先用已有的数据快速渲染一次
    renderMetaAndBody(note);
    previewBodyEl.scrollTop = 0;

    // 如果还没有完整正文，异步在后台拉取并无缝刷新
    if (!note.contentMarkdown) {
      const curId = note.id;
      engine.getFullNote(curId).then((full) => {
        if (full && currentResults[selectedIndex]?.id === curId) {
          renderMetaAndBody(full);
        }
      }).catch(() => {});
    }
  }

  // 打开选中笔记 (使用 EdgeEver 官方标准导航 API: context.ui.openNote)
  async function openTargetNote(note) {
    if (!note || !note.id) return;
    try {
      const searchKeyword = activeKeywords && activeKeywords.length > 0 ? activeKeywords.join(" ") : undefined;

      // 1. EdgeEver 官方标准导航 API (支持在打开后自动高亮定位关键词)
      if (context.ui?.openNote) {
        await context.ui.openNote(note.id, searchKeyword ? { search: searchKeyword } : undefined);
      } else if (context.editor?.openDocument) {
        await context.editor.openDocument({ noteId: note.id });
      } else if (context.notes?.open) {
        await context.notes.open(note.id);
      } else if (context.workspace?.openNote) {
        await context.workspace.openNote(note.id);
      }

      context.ui?.showNotice?.(`已快速打开笔记：《${note.title}》`);
    } catch (err) {
      console.warn("[Enhancing Search] 打开笔记异常:", err);
      context.ui?.showNotice?.(`打开笔记失败: ${err.message || err}`);
    }
    closeModal();
  }

  // 渲染左侧结果列表
  function renderList() {
    listContainer.innerHTML = "";

    if (currentResults.length === 0) {
      listContainer.innerHTML = `
        <div class="edgeever-search-empty-state">
          <div class="edgeever-search-empty-title">无匹配笔记</div>
          <div class="edgeever-search-empty-desc">换个关键词试试，或扩大时间范围</div>
        </div>
      `;
      renderPreview(null);
      return;
    }

    if (selectedIndex >= currentResults.length) {
      selectedIndex = 0;
    }

    currentResults.forEach((note, idx) => {
      const card = document.createElement("div");
      card.className = `edgeever-search-card ${idx === selectedIndex ? "is-selected" : ""}`;
      card.dataset.index = idx;

      // 标题高亮
      let titleHtml = escapeHtml(note.title);
      for (const kw of activeKeywords) {
        if (!kw) continue;
        const re = new RegExp(`(${escapeRegExp(escapeHtml(kw))})`, "gi");
        titleHtml = titleHtml.replace(re, '<mark class="ee-search-hl">$1</mark>');
      }

      // 标签徽标
      const tagsPills = note.tags && note.tags.length > 0
        ? note.tags.slice(0, 3).map((t) => `<span class="edgeever-meta-tag is-user-tag">#${escapeHtml(t)}</span>`).join("")
        : "";

      const timeVal = dateField === "created" ? note.createdAt : note.updatedAt;

      card.innerHTML = `
        <div class="edgeever-search-card-header">
          <div class="edgeever-search-card-title">${titleHtml}</div>
          <div class="edgeever-search-card-time">${formatRelativeTime(timeVal)}</div>
        </div>
        <div class="edgeever-search-card-meta">
          <span class="edgeever-meta-tag is-notebook">📁 ${escapeHtml(note.notebookName)}</span>
          ${tagsPills}
        </div>
        <div class="edgeever-search-card-snippet">
          ${note.snippet}
        </div>
      `;

      card.addEventListener("click", () => {
        selectedIndex = idx;
        updateSelectedCardVisual();
        renderPreview(currentResults[selectedIndex]);
      });

      card.addEventListener("dblclick", () => {
        openTargetNote(currentResults[idx]);
      });

      listContainer.appendChild(card);
    });

    renderPreview(currentResults[selectedIndex]);
  }

  function updateSelectedCardVisual() {
    const cards = listContainer.querySelectorAll(".edgeever-search-card");
    cards.forEach((c, i) => {
      if (i === selectedIndex) {
        c.classList.add("is-selected");
        c.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } else {
        c.classList.remove("is-selected");
      }
    });
  }

  // 执行搜索
  function doSearch() {
    const t0 = performance.now();
    const query = inputEl.value;

    if (query.trim().length > 0) {
      clearBtn.style.display = "flex";
    } else {
      clearBtn.style.display = "none";
    }

    const { results, queryKeywords, totalCount } = engine.search(currentNotes, {
      query,
      dateRange,
      dateField,
      sortMode,
      selectedTag,
    });

    const costMs = Math.round(performance.now() - t0);
    currentResults = results;
    activeKeywords = queryKeywords;

    statsTextEl.textContent = `找到 ${totalCount} 篇相关笔记`;
    timeCostEl.textContent = `${costMs} ms`;

    renderList();
  }

  const debouncedSearch = debounce(doSearch, 80);

  // 绑定交互事件
  inputEl.addEventListener("input", debouncedSearch);

  clearBtn.addEventListener("click", () => {
    inputEl.value = "";
    inputEl.focus();
    doSearch();
  });

  // 时间维度 Pills 切换
  backdrop.querySelectorAll(".edgeever-filter-pill[data-range]").forEach((pill) => {
    pill.addEventListener("click", () => {
      backdrop.querySelectorAll(".edgeever-filter-pill[data-range]").forEach((p) => p.classList.remove("is-active"));
      pill.classList.add("is-active");
      dateRange = pill.dataset.range;
      doSearch();
    });
  });

  dateFieldSelect.addEventListener("change", (e) => {
    dateField = e.target.value;
    doSearch();
  });

  sortModeSelect.addEventListener("change", (e) => {
    sortMode = e.target.value;
    doSearch();
  });

  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ 正在索引...";
    statsTextEl.textContent = "正在重新扫描应用内所有笔记...";
    currentNotes = await engine.fetchAllNotes(true);
    refreshBtn.disabled = false;
    refreshBtn.textContent = "🔄 刷新索引";
    cachedCountEl.textContent = `已索引 ${currentNotes.length} 篇笔记`;
    doSearch();
  });

  previewOpenBtn.addEventListener("click", () => {
    if (currentResults[selectedIndex]) {
      openTargetNote(currentResults[selectedIndex]);
    }
  });

  // 全局键盘监听 (ESC, 上下切换, 回车)
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (currentResults.length > 0) {
        selectedIndex = (selectedIndex + 1) % currentResults.length;
        updateSelectedCardVisual();
        renderPreview(currentResults[selectedIndex]);
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (currentResults.length > 0) {
        selectedIndex = (selectedIndex - 1 + currentResults.length) % currentResults.length;
        updateSelectedCardVisual();
        renderPreview(currentResults[selectedIndex]);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (currentResults[selectedIndex]) {
        openTargetNote(currentResults[selectedIndex]);
      }
      return;
    }
  });

  // 初始全量索引加载
  (async () => {
    statsTextEl.textContent = "正在极速加载全库索引...";
    currentNotes = await engine.fetchAllNotes(false);
    cachedCountEl.textContent = `已索引 ${currentNotes.length} 篇笔记`;
    doSearch();
    inputEl.focus();
  })();
}

// ==================== 4. 插件生命周期与统一插件扩展坞 (Dock) ====================

export default {
  activate(context) {
    const engine = new EnhancedSearchEngine(context);

    let settings = {
      buttonPosition: "dock",
      defaultSort: "relevance",
    };

    async function loadSettings() {
      try {
        const pos = await context.settings?.get?.("button_position");
        if (pos) settings.buttonPosition = String(pos);
        const sort = await context.settings?.get?.("default_sort");
        if (sort) settings.defaultSort = String(sort);
      } catch (e) {}
    }

    loadSettings();

    // 注册快捷键与命令面板入口 (Cmd/Ctrl + Shift + F)
    context.commands?.register?.({
      id: "enhancing-search-open",
      title: "全库增强搜索 (Spotlight 卡片预览)...",
      shortcut: "Mod-Shift-F",
      execute: () => openSearchModal(context, engine),
    });

    // 挂载逻辑
    let currentBtn = null;

    function cleanupButton() {
      if (currentBtn) {
        try {
          currentBtn.remove();
        } catch (e) {}
        currentBtn = null;
      }
      document
        .querySelectorAll("#edgeever-enhancing-search-btn, .edgeever-enhancing-search-trigger-btn")
        .forEach((b) => b.remove());
    }

    function getOrCreatePluginDock() {
      let dock = document.getElementById("edgeever-plugins-dock");
      if (!dock) {
        dock = document.createElement("div");
        dock.id = "edgeever-plugins-dock";
        dock.className = "edgeever-plugins-dock";
        document.body.appendChild(dock);
      }
      // 智能检查并收纳其他孤立挂在 body 的插件悬浮球（如导出插件、GitHub热搜），避免任何重叠
      try {
        const exportBtn = document.getElementById("edgeever-enhancing-export-btn");
        if (exportBtn && exportBtn.parentElement === document.body) {
          dock.appendChild(exportBtn);
        }
        const ghBtn = document.getElementById("edgeever-github-hot-btn");
        if (ghBtn && ghBtn.parentElement === document.body) {
          dock.appendChild(ghBtn);
        }
      } catch (e) {}
      return dock;
    }

    function findSidebarFooter() {
      const selectors = [
        ".edgeever-workspace-sidebar-footer",
        ".edgeever-workspace-sidebar footer",
        ".sidebar-footer",
        "[class*='sidebar-footer']",
        ".edgeever-workspace-sidebar [class*='footer']",
        ".edgeever-workspace-sidebar",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    function findToolbar() {
      const selectors = [
        ".edgeever-workspace-editor header .actions",
        ".edgeever-workspace-editor header",
        ".edgeever-editor-toolbar",
        ".ProseMirror-menubar",
        ".tiptap-toolbar",
        '[role="toolbar"]',
        ".editor-toolbar",
        ".note-editor-toolbar",
        ".edgeever-workspace-editor [class*='header-action']",
        ".edgeever-workspace-editor [class*='header']",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    function ensureButtonMounted() {
      if (settings.buttonPosition === "hidden") {
        cleanupButton();
        return;
      }

      if (currentBtn && currentBtn.isConnected) {
        if (settings.buttonPosition === "dock" && currentBtn.parentElement?.id !== "edgeever-plugins-dock") {
          cleanupButton();
        } else if (settings.buttonPosition === "sidebar" && !currentBtn.classList.contains("is-sidebar-btn")) {
          cleanupButton();
        } else if (settings.buttonPosition === "toolbar" && !currentBtn.classList.contains("is-toolbar-btn")) {
          cleanupButton();
        } else {
          return;
        }
      }

      const existing = document.getElementById("edgeever-enhancing-search-btn");
      if (existing && existing.isConnected) {
        if (settings.buttonPosition === "dock" && existing.parentElement?.id !== "edgeever-plugins-dock") {
          const dock = getOrCreatePluginDock();
          dock.appendChild(existing);
          existing.className = "edgeever-enhancing-search-trigger-btn is-dock-btn";
        }
        currentBtn = existing;
        return;
      }

      cleanupButton();

      const btn = document.createElement("button");
      btn.type = "button";
      btn.id = "edgeever-enhancing-search-btn";
      btn.title = "全库增强搜索 (Cmd/Ctrl+Shift+F)";

      const svgIcon = `
        <svg viewBox="0 0 24 24">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
        </svg>
      `;

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSearchModal(context, engine);
      });

      // 1. 侧边栏底部模式
      if (settings.buttonPosition === "sidebar") {
        const sidebar = findSidebarFooter();
        if (sidebar) {
          btn.className = "edgeever-enhancing-search-trigger-btn is-sidebar-btn";
          btn.innerHTML = svgIcon;
          sidebar.appendChild(btn);
          currentBtn = btn;
          return;
        }
      }

      // 2. 编辑器工具栏模式
      if (settings.buttonPosition === "toolbar") {
        const tb = findToolbar();
        if (tb) {
          btn.className = "edgeever-enhancing-search-trigger-btn is-toolbar-btn";
          btn.innerHTML = svgIcon;
          tb.appendChild(btn);
          currentBtn = btn;
          return;
        }
      }

      // 3. 统一插件工具坞 (Plugin Dock - 自动弹性排队，与其他插件并存)
      const dock = getOrCreatePluginDock();
      btn.className = "edgeever-enhancing-search-trigger-btn is-dock-btn";
      btn.innerHTML = svgIcon;
      dock.appendChild(btn);
      currentBtn = btn;
    }

    let timer = null;
    const observer = new MutationObserver(() => {
      if (currentBtn && currentBtn.isConnected) return;
      clearTimeout(timer);
      timer = setTimeout(ensureButtonMounted, 350);
    });

    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(ensureButtonMounted, 300);

    const onSettingsChanged = context.events?.on?.("settings.changed", async () => {
      await loadSettings();
      cleanupButton();
      ensureButtonMounted();
    });

    return () => {
      observer.disconnect();
      cleanupButton();
      onSettingsChanged?.();
      document.querySelectorAll(".edgeever-search-backdrop").forEach((b) => b.remove());
    };
  },
};

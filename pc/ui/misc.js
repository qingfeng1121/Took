/* misc.js —— P2 笔记页增强 + FAB（只在本文件内实现，不改 app.js）。
   数据一律经 window.Took 取；写操作复用 app.js 既有的命令与流程，不另开一套。
     ① bookFilters        笔记本列表顶部的分类筛选条
     ② bookMore / bookMenu 笔记编辑页右上角「⋯」：重命名 / 删除
     ③ bookThink          思维笔记（正文空 → 禁用；非空 → 转成思维导图视图）
     ④ bookNewCatInput    分类选择层里的「新建分类」输入框 + 确定 / 取消
     ⑤ fab                日历页右下角橙色 ＋，点了打开管理页并定位到「新建」 */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  /* 管理页的真实列表由 mgr.js 渲染在 #mgrRoot 里的 .mgr-list 中；
     app.js 那份旧的 #memoList 被 CSS 隐藏（#configMain > :not(#mgrRoot){display:none}），
     所以筛选条必须挂在 #mgrRoot 上，否则看不见也筛不到。 */
  var mgrRoot = function () { return document.getElementById('mgrRoot'); };
  var memoRows = function () {
    return $$('#mgrRoot .memo-row');
  };
  /* 笔记本列表：优先用 window.Took 的权威数据（app.js 的缓存），拿不到再退回已渲染的 DOM。
     两条路都不写 app.js 的状态，只读。 */
  var notebookMemos = function () {
    try {
      var all = window.Took && window.Took.memos && window.Took.memos();
      if (all && all[2] && all[2].length) return all[2];
    } catch (e) { /* 接口不可用就退回 DOM */ }
    return memoRows().map(function (row) {
      var chip = row.querySelector('.memo-cat');
      return { category: chip ? chip.textContent : '' };
    });
  };

  var CAT_NONE = '未分类';
  var CAT_ALL = '__all__';

  function screens() {
    return ['configScreen', 'settingsScreen', 'analysisScreen', 'bookScreen']
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);
  }
  function calendarVisible() {
    return screens().every(function (el) { return el.hidden; });
  }

  /* ==========================================================================
     ① 笔记本分类筛选条
     app.js 每次渲染都整体替换 #configMain.innerHTML，所以筛选条不能写死在
     index.html 里（会被冲掉）：本文件创建节点，用 MutationObserver 跟随重渲染。
     ========================================================================== */
  var FILTER = { cat: CAT_ALL };
  var barEl = null;
  var barHtml = '';

  function notebookCategories() {
    var out = [];
    notebookMemos().forEach(function (m) {
      var c = String((m && m.category) || '').trim();
      if (c && c !== CAT_NONE && out.indexOf(c) < 0) out.push(c);
    });
    return out;
  }
  function isNotebookTab() {
    var b = $('#configNav button[data-tab="notebook"]');
    return !!b && b.classList.contains('on');
  }

  function chips() {
    var cats = notebookCategories();
    if (FILTER.cat !== CAT_ALL && FILTER.cat !== CAT_NONE && cats.indexOf(FILTER.cat) < 0) {
      FILTER.cat = CAT_ALL;                       // 选中的分类没了（改名 / 删光）→ 退回全部
    }
    return [[CAT_ALL, '全部'], [CAT_NONE, CAT_NONE]]
      .concat(cats.map(function (c) { return [c, c]; }));
  }

  function renderBar() {
    if (!barEl) return;
    var html = chips().map(function (p) {
      var on = FILTER.cat === p[0];
      return '<button type="button" class="book-filter' + (on ? ' on' : '') + '"' +
        ' data-bookfilter="' + esc(p[0]) + '" aria-pressed="' + on + '">' + esc(p[1]) + '</button>';
    }).join('');
    if (html !== barHtml) { barEl.innerHTML = html; barHtml = html; }
  }

  function applyFilter() {
    var card = mgrRoot() && mgrRoot().querySelector('.mgr-list');
    var rows = memoRows();
    if (!card) return;
    var shown = 0;
    rows.forEach(function (row) {
      var chip = row.querySelector('.memo-cat');
      var cat = chip ? String(chip.textContent || '').trim() : CAT_NONE;
      var hit = FILTER.cat === CAT_ALL || cat === FILTER.cat;
      row.classList.toggle('book-hide', !hit);
      /* 内联 display 压得住样式表里的任何规则（管理页的行是 .mgr-list > .memo-row 的 flex），
         不依赖 style.css 里的选择器权重。 */
      row.style.display = hit ? '' : 'none';
      if (hit) shown += 1;
    });
    /* 提示节点只在内容真的变化时才写：写 textContent 本身就是 childList 变更，
       会再次触发下面观察 configMain 的 MutationObserver，值不变就必须跳过。 */
    var hint = document.getElementById('bookFilterEmpty');
    if (!shown && rows.length) {
      var text = '「' + (FILTER.cat === CAT_ALL ? '全部' : FILTER.cat) + '」下没有笔记。';
      if (!hint) {
        hint = document.createElement('div');
        hint.id = 'bookFilterEmpty';
        hint.className = 'book-filter-empty';
        hint.textContent = text;
        card.appendChild(hint);
      } else if (hint.textContent !== text) {
        hint.textContent = text;
      }
    } else if (hint && hint.parentNode) {
      hint.parentNode.removeChild(hint);
    }
  }

  function ensureBar() {
    var main = document.getElementById('configMain');
    if (!main) return;
    /* 不是笔记本页、或者一条笔记都没有 → 不出现筛选条 */
    if (!isNotebookTab() || !notebookMemos().length) {
      if (barEl && barEl.parentNode) barEl.parentNode.removeChild(barEl);
      return;
    }
    if (!barEl) {
      barEl = document.createElement('div');
      barEl.className = 'book-filters';
      barEl.id = 'bookFilters';
      barEl.setAttribute('aria-label', '按分类筛选笔记');
      barEl.addEventListener('click', function (e) {
        var b = e.target.closest('[data-bookfilter]');
        if (!b) return;
        FILTER.cat = b.dataset.bookfilter;
        renderBar();
        applyFilter();
      });
    }
    /* 挂在 .mgr-list 前面（列表正上方），没有列表时挂在 #mgrRoot 里 */
    var root = mgrRoot();
    if (!root) return;
    var list = root.querySelector('.mgr-list');
    var host = list ? list.parentNode : root;
    if (list) {
      if (barEl.nextSibling !== list || barEl.parentNode !== host) host.insertBefore(barEl, list);
    } else if (barEl.parentNode !== host) {
      host.appendChild(barEl);
    }
    renderBar();
    applyFilter();
  }

  /* ==========================================================================
     ② 笔记编辑页右上角「⋯」菜单
     ========================================================================== */
  function menuParts() {
    return {
      wrap: document.getElementById('bookMoreWrap'),
      btn: document.getElementById('bookMore'),
      menu: document.getElementById('bookMenu'),
      row: document.getElementById('bookRenameRow'),
      input: document.getElementById('bookRenameInput'),
      hint: document.getElementById('bookRenameHint')
    };
  }
  function closeMenu() {
    var m = menuParts();
    if (!m.menu) return;
    m.menu.hidden = true;
    if (m.btn) m.btn.setAttribute('aria-expanded', 'false');
    if (m.row) m.row.hidden = true;
    if (m.hint) { m.hint.hidden = true; m.hint.textContent = ''; }
  }
  function renameHint(text) {
    var m = menuParts();
    if (!m.hint) return;
    m.hint.textContent = text || '';
    m.hint.hidden = !text;
  }
  function openRename() {
    var m = menuParts();
    var title = document.getElementById('bookTitle');
    if (!m.row || !m.input || !title) return;
    renameHint('');
    m.row.hidden = false;
    m.input.value = String(title.textContent || '');
    m.input.focus();
    m.input.select();
  }
  function commitRename() {
    var m = menuParts();
    var title = document.getElementById('bookTitle');
    if (!m.input || !title) return;
    var name = String(m.input.value || '').trim();
    if (!name) { renameHint('标题不能为空'); m.input.focus(); return; }
    if (name.length > 60) { renameHint('标题最多 60 个字'); return; }
    if (name === String(title.textContent || '').trim()) { closeMenu(); return; }
    title.textContent = name;
    /* 走 app.js 的自动保存链：input → queueBookSave → update_memo（真落库） */
    title.dispatchEvent(new Event('input', { bubbles: true }));
    closeMenu();
    refreshThink();
  }

  /* ==========================================================================
     ③ 思维笔记：正文空 → 禁用（照原型，不做假按钮）；非空 → 转成导图视图
     ========================================================================== */
  function refreshThink() {
    var body = document.getElementById('bookBody');
    var btn = document.getElementById('bookThink');
    if (!body || !btn) return;
    var has = String(body.value || '').trim().length > 0;
    btn.disabled = !has;
    btn.title = has ? '把正文按层级转成思维导图' : '正文为空时没有可转换的内容';
  }

  function lineLevel(line) {
    var indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
    var level = Math.floor(indent / 2);
    var h = line.trim().match(/^(#{1,6})\s+/);
    if (h) level = h[1].length - 1;
    return level;
  }
  function lineText(line) {
    return line.trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .trim();
  }
  function buildTree(text) {
    var root = { text: '', children: [] };
    var stack = [{ node: root, level: -1 }];
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      if (!raw.trim()) return;
      var node = { text: lineText(raw), children: [] };
      var level = lineLevel(raw);
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node: node, level: level });
    });
    return root;
  }
  function treeHtml(nodes) {
    if (!nodes.length) return '';
    return '<ul>' + nodes.map(function (n) {
      return '<li><span class="think-node">' + esc(n.text || '（空）') + '</span>' +
        treeHtml(n.children) + '</li>';
    }).join('') + '</ul>';
  }

  function openThink() {
    var body = document.getElementById('bookBody');
    var btn = document.getElementById('bookThink');
    var view = document.getElementById('bookThinkView');
    var canvas = document.getElementById('bookThinkCanvas');
    var sub = document.getElementById('bookThinkSub');
    var doc = $('.be-doc');
    if (!body || !view || !canvas) return;
    if (btn && btn.disabled) return;
    var tree = buildTree(body.value);
    if (!tree.children.length) { refreshThink(); return; }
    var title = document.getElementById('bookTitle');
    var head = String((title && title.textContent) || '').trim();
    canvas.innerHTML = '<div class="think-root">' + esc(head || tree.children[0].text || '思维笔记') + '</div>' +
      treeHtml(tree.children);
    if (sub) sub.textContent = $$('.think-node', canvas).length + ' 个节点 · 按正文层级生成';
    if (doc) doc.hidden = true;
    view.hidden = false;
    var back = document.getElementById('bookThinkBack');
    if (back) back.focus();
  }
  function closeThink() {
    var view = document.getElementById('bookThinkView');
    var doc = $('.be-doc');
    if (view) view.hidden = true;
    if (doc) doc.hidden = false;
    var body = document.getElementById('bookBody');
    if (body) body.focus();
  }

  /* ==========================================================================
     ④ 分类选择层里的「新建分类」
     #bookNewCat / #bookNewCatBtn 是 app.js 启动时按 id 绑定的（隐藏镜像 + 确定按钮），
     真正的输入框是 #bookNewCatInput：输入时把值镜像过去，确定时点 app.js 的按钮，
     走它既有的「新建 → 选中 → 600ms 自动保存落库」那条路。
     ========================================================================== */
  function pickerParts() {
    return {
      open: document.getElementById('bookNewCatOpen'),
      form: document.getElementById('bookNewCatForm'),
      input: document.getElementById('bookNewCatInput'),
      mirror: document.getElementById('bookNewCat'),
      ok: document.getElementById('bookNewCatBtn'),
      cancel: document.getElementById('bookNewCatCancel'),
      hint: document.getElementById('bookNewCatHint')
    };
  }
  function newCatHint(text) {
    var p = pickerParts();
    if (!p.hint) return;
    p.hint.textContent = text || '';
    p.hint.hidden = !text;
  }
  function showNewCatForm(on) {
    var p = pickerParts();
    if (!p.form || !p.open) return;
    p.form.hidden = !on;
    p.open.hidden = on;
    if (on) {
      newCatHint('');
      if (p.input) { p.input.value = ''; p.input.focus(); }
      if (p.mirror) p.mirror.value = '';
    }
  }
  function commitNewCat() {
    var p = pickerParts();
    // 两个来源都读：新输入框 #bookNewCatInput 优先，回落旧镜像 #bookNewCat。
    // 为什么：既有回归脚本 verify-memo.cjs 只填旧镜像 #bookNewCat（它早于本文件存在），
    // 只读新输入框会被判成「分类名为空」。真机用户点的是新输入框，两条路都要通。
    var name = String(
      (p.input && p.input.value) || (p.mirror && p.mirror.value) || ''
    ).trim();
    if (!name) { newCatHint('分类名不能为空'); if (p.input) p.input.focus(); return; }
    if (name.length > 20) { newCatHint('分类名最多 20 个字'); return; }
    if (name === CAT_NONE) { newCatHint('「' + CAT_NONE + '」是内置分类，换一个名字'); return; }
    newCatHint('');
    if (p.mirror) p.mirror.value = name;
    if (p.ok) p.ok.click();          // app.js：写入 chip → 关层 → queueBookSave 落库
    showNewCatForm(false);
  }

  /* ==========================================================================
     ⑤ FAB（右下角橙色 ＋）：与 T3 管理页的 FAB 是同一个 —— 已有就复用，没有才建
     ========================================================================== */
  var myFab = null;

  function fabIcon() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  }
  function openManagerNew() {
    /* 2026-10-27：原来的 #btnConfig 已按用户要求删除，「新建与管理」是唯一入口。 */
    var cfg = document.getElementById('btnNew');
    if (!cfg) return;
    cfg.click();                                   // app.js：configTab='rules' + 渲染配置页
    var tries = 0;
    (function locate() {
      var newRule = document.getElementById('newRule');
      if (newRule) { newRule.click(); return; }    // 定位到「新建」
      if (tries++ < 8) setTimeout(locate, 80);
    })();
  }
  /* 可见性：日历页与管理页都显示，两个页面共用一个 FAB。
     - 日历页：点它 = 打开管理页并定位到「新建」（本文件绑定）。
     - 管理页：mgr.js 在捕获阶段把这次点击截走，按当前分类新建，不会落到本文件的监听器上。
     - 设置页 / 统计页 / 笔记本编辑页：收起，不能浮在别人的面板上。
     hidden 之外再钉一次 style.display，别处取消隐藏时这里仍然压得住。 */
  function fabVisible() {
    if (calendarVisible()) return true;
    var cfg = document.getElementById('configScreen');
    return !!cfg && !cfg.hidden;
  }
  function syncFab() {
    var el = window.TookFab && window.TookFab.el && window.TookFab.el();
    if (!el) return;
    var show = fabVisible();
    el.hidden = !show;
    el.style.display = show ? '' : 'none';
  }
  function ensureFab() {
    /* 与 T3 管理页的 FAB 是同一个：它建在 #configScreen 里（#mgrFab）。
       这里把它从那个 section 挪到 body 上 —— 否则日历页显示时它随着 section 一起被隐藏，
       量出来就是 0×0。挪一次即可，后续一直复用，绝不重复创建。 */
    var existing = document.getElementById('mgrFab') || document.querySelector('.fab');
    if (!existing) {
      existing = document.createElement('button');
      existing.type = 'button';
      existing.className = 'fab';
      existing.id = 'mgrFab';
      existing.innerHTML = fabIcon();
      document.body.appendChild(existing);
    }
    if (existing.parentNode !== document.body) document.body.appendChild(existing);
    if (!existing.dataset.tookFabBound) {
      existing.dataset.tookFabBound = '1';
      if (!existing.querySelector('svg')) existing.innerHTML = fabIcon();
      /* 日历页上的语义是「新建与管理」；管理页里由 mgr.js 的 renderChrome 改成「新建<分类>」 */
      existing.addEventListener('click', openManagerNew);
    }
    window.TookFab = {
      el: function () { return document.getElementById('mgrFab') || document.querySelector('.fab'); },
      sync: syncFab,
      openNew: openManagerNew
    };
    syncFab();
  }

  /* ==========================================================================
     绑定 + 观察
     ========================================================================== */
  function bindMenu() {
    var m = menuParts();
    if (!m.btn || !m.menu) return;
    m.btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = m.menu.hidden;
      m.menu.hidden = !open;
      m.btn.setAttribute('aria-expanded', String(open));
      if (!open) { m.row.hidden = true; renameHint(''); }
    });
    m.menu.addEventListener('click', function (e) {
      var item = e.target.closest('[data-bmenu]');
      if (!item) return;
      if (item.dataset.bmenu === 'rename') { openRename(); return; }
      if (item.dataset.bmenu === 'del') {
        closeMenu();
        var del = document.getElementById('bookDel');
        if (del) del.click();           // 复用 app.js 既有的二次确认删除
      }
    });
    var ok = document.getElementById('bookRenameOk');
    var cancel = document.getElementById('bookRenameCancel');
    if (ok) ok.addEventListener('click', commitRename);
    if (cancel) cancel.addEventListener('click', function () { m.row.hidden = true; });
    if (m.input) {
      m.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitRename(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.row.hidden = true; }
      });
    }
    document.addEventListener('click', function (e) {
      if (!m.menu || m.menu.hidden) return;
      if (e.target.closest('#bookMoreWrap')) return;
      closeMenu();
    });
    /* Escape 必须在 app.js 的 document 监听（会整页关闭）之前拦下 → 捕获阶段 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!m.menu || m.menu.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }, true);
  }

  function bindThink() {
    var btn = document.getElementById('bookThink');
    var back = document.getElementById('bookThinkBack');
    var body = document.getElementById('bookBody');
    if (btn) btn.addEventListener('click', openThink);
    if (back) back.addEventListener('click', closeThink);
    if (body) body.addEventListener('input', refreshThink);
  }

  function bindPicker() {
    var p = pickerParts();
    if (p.open) p.open.addEventListener('click', function () { showNewCatForm(true); });
    if (p.cancel) p.cancel.addEventListener('click', function () { showNewCatForm(false); });
    if (p.input) {
      p.input.addEventListener('input', function () {
        if (p.mirror) p.mirror.value = p.input.value;
        newCatHint('');
      });
      p.input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitNewCat(); }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          if (p.form && !p.form.hidden) showNewCatForm(false);
        }
      });
    }
    /* 校验挂在 app.js 绑定的那个「确定」按钮上：捕获阶段先判空 / 超长 / 内置名，
       不合法就拦下（app.js 的处理器不会给提示），合法才让它继续走既有的新建流程。 */
    if (p.ok) {
      p.ok.addEventListener('click', function (e) {
        /* 两条入口都要认：界面里在 #bookNewCatInput 输入（本文件把它镜像到 #bookNewCat），
           既有回归脚本则直接给 #bookNewCat 赋值 —— 谁有值就用谁。 */
        var typed = String((p.input && p.input.value) || '').trim();
        var mirrored = String((p.mirror && p.mirror.value) || '').trim();
        var name = typed || mirrored;
        if (name && p.mirror) p.mirror.value = name;
        if (!name) { e.preventDefault(); e.stopImmediatePropagation(); newCatHint('分类名不能为空'); if (p.input) p.input.focus(); return; }
        if (name.length > 20) { e.preventDefault(); e.stopImmediatePropagation(); newCatHint('分类名最多 20 个字'); return; }
        if (name === CAT_NONE) { e.preventDefault(); e.stopImmediatePropagation(); newCatHint('「' + CAT_NONE + '」是内置分类，换一个名字'); return; }
        if (p.mirror) p.mirror.value = name;
        newCatHint('');
      }, true);
    }
    /* 分类层每次打开都收起「新建」表单，不留上一次的半截输入 */
    var catBtn = document.getElementById('bookCat');
    if (catBtn) catBtn.addEventListener('click', function () { showNewCatForm(false); });
    /* 分类层被关掉（点遮罩 / Esc / 选中分类）时也收起 */
    var mask = document.getElementById('bookPickerMask');
    if (mask) {
      new MutationObserver(function () {
        if (mask.hidden) showNewCatForm(false);
      }).observe(mask, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  function observe() {
    var main = document.getElementById('configMain');
    if (main && window.MutationObserver) {
      /* mgr.js 每次渲染都整体重写 #mgrRoot.innerHTML（筛选条会被一起冲掉），
         这里跟着重挂。观察 configMain 的子树即可覆盖 #mgrRoot 的增删。 */
      new MutationObserver(function () { ensureBar(); }).observe(main, { childList: true, subtree: true });
    }
    var nav = document.getElementById('configNav');
    if (nav && window.MutationObserver) {
      new MutationObserver(function () { ensureBar(); })
        .observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    if (window.MutationObserver) {
      screens().forEach(function (el) {
        new MutationObserver(function () {
          syncFab();
          var book = document.getElementById('bookScreen');
          if (book && !book.hidden) { setTimeout(refreshThink, 0); return; }
          closeMenu();
          if (!document.getElementById('bookThinkView').hidden) closeThink();
        }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
      });
    }
  }

  function boot() {
    ensureFab();
    ensureBar();
    bindMenu();
    bindThink();
    bindPicker();
    observe();
    refreshThink();
    /* app.js 首屏是异步渲染的：补两次，保证刚进笔记本页就有筛选条 */
    setTimeout(function () { ensureFab(); ensureBar(); refreshThink(); }, 400);
    setTimeout(function () { ensureFab(); ensureBar(); }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 验收脚本 / 其它模块的只读入口 */
  /**
   * 从外部（mgr.js 的笔记行）打开某条笔记的全屏编辑器。
   * 做法：找到 app.js 渲染在 #memoList 里的对应行并 .click() 它 ——
   * 这样走的是 app.js 自己的「选中 → 填标题/正文/分类 → 显示 #bookScreen」那条路，
   * 不重复实现一遍编辑器的装载逻辑。
   */
  function openBookById(id) {
    if (!id) return false;
    var rows = document.querySelectorAll('#memoList [data-id], #memoList .memo-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var rid = row.dataset.id || row.getAttribute('data-id') ||
        (row.querySelector('[data-id]') || {}).dataset?.id;
      if (rid && String(rid) === String(id)) { row.click(); return true; }
    }
    // 找不到行（例如分类筛选把行藏了）就退回：按标题匹配
    try {
      var all = window.Took && window.Took.memos && window.Took.memos();
      var memo = all && all[2] && all[2].filter(function (m) { return String(m.id) === String(id); })[0];
      if (memo) {
        var byTitle = document.querySelectorAll('#memoList .memo-row');
        for (var k = 0; k < byTitle.length; k++) {
          var b = byTitle[k].querySelector('b');
          if (b && String(b.textContent).trim() === String(memo.title).trim()) { byTitle[k].click(); return true; }
        }
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  window.TookBook = {
    /** 打开某条笔记（供 mgr.js 的笔记行调用） */
    open: openBookById,
    filter: function () { return FILTER.cat; },
    setFilter: function (cat) {
      FILTER.cat = cat == null ? CAT_ALL : String(cat);
      renderBar();
      applyFilter();
    },
    categories: notebookCategories,
    thinkOpen: function () {
      var v = document.getElementById('bookThinkView');
      return !!v && !v.hidden;
    },
    visibleRows: function () {
      return memoRows().filter(function (r) { return !r.classList.contains('book-hide'); })
        .map(function (r) { return (r.querySelector('b') || {}).textContent || ''; });
    }
  };
})();

(function () {
  'use strict';

  var state = { snapshot: null, pending: 0, problems: [], apps: null, calendar: null };
  var tabId = localGet('tab') || 'furniture';
  var adding = {}; // group heading -> add box open
  var writing = {}; // task or question key -> note / answer box open
  var drafts = {}; // what's typed in those boxes, kept across re-renders
  var justOpened = null;

  function $(id) { return document.getElementById(id); }

  function localGet(k) { try { return localStorage.getItem('home.' + k); } catch (e) { return null; } }
  function localSet(k, v) { try { localStorage.setItem('home.' + k, v); } catch (e) { /* private window */ } }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'className') node.className = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
      });
    });
  }

  // ── Markdown, just enough for the Obsidian notes ──

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // Dates like 2026-10-17 in the notes show as October 17, 2026 (not inside links or file paths)
  function inline(s) {
    return escapeHtml(s)
      .replace(/(^|[^\w\/.-])(20\d\d-\d\d-\d\d)(?![\w\/-])/g, function (all, pre, iso) { return pre + longDate(iso); })
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }

  function block(text) {
    var out = [];
    var list = null;
    text.split('\n').forEach(function (line) {
      var ol = /^\s*\d+\.\s+(.*)$/.exec(line);
      var ul = /^\s*[-*]\s+(.*)$/.exec(line);
      var item = ol || ul;
      if (item) {
        var tag = ol ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { if (list) out.push('</' + list.tag + '>'); list = { tag: tag }; out.push('<' + tag + '>'); }
        out.push('<li>' + inline(item[1]) + '</li>');
        return;
      }
      if (list) { out.push('</' + list.tag + '>'); list = null; }
      if (line.trim()) out.push('<p>' + inline(line.trim()) + '</p>');
    });
    if (list) out.push('</' + list.tag + '>');
    return out.join('');
  }

  // ── Login ──

  function showLogin() {
    $('app').hidden = true;
    $('login').hidden = false;
    $('password').focus();
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('login-error').textContent = '';
    api('auth-login', { method: 'POST', body: { password: $('password').value } })
      .then(start)
      .catch(function (err) { $('login-error').textContent = err.message === 'Unauthorized' ? 'Incorrect password' : err.message; });
  });

  $('logout').addEventListener('click', function () {
    api('auth-logout', { method: 'POST' }).catch(function () {}).then(showLogin);
  });

  // The Sites menu closes when you click anywhere else or pick a link
  document.addEventListener('click', function (e) {
    var menu = $('sites');
    if (menu.open && (!menu.contains(e.target) || e.target.closest('a'))) menu.open = false;
  });

  $('refresh').addEventListener('click', function () { load(); loadApps(); loadCalendar(); });

  function start() {
    $('login').hidden = true;
    $('app').hidden = false;
    $('today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('show-done').checked = localGet('showDone') === '1';
    load();
    loadApps();
    loadCalendar();
  }

  function load() {
    return api('home').then(function (r) {
      state.snapshot = r.snapshot;
      state.pending = r.pending;
      state.problems = r.problems || [];
      render();
    }).catch(function (err) {
      if (err.message !== 'Unauthorized') $('sync-status').textContent = err.message;
    });
  }

  function loadApps() {
    return api('apps').then(function (apps) {
      state.apps = apps;
      renderApps();
    }).catch(function () {});
  }

  // ── Dates ──

  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function daysUntil(iso) {
    return Math.round((new Date(iso + 'T12:00:00') - new Date(todayIso() + 'T12:00:00')) / 864e5);
  }

  function ago(iso) {
    var mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins / 60);
    if (h < 36) return h + (h === 1 ? ' hour ago' : ' hours ago');
    return Math.round(h / 24) + ' days ago';
  }

  // Dates always written out in full: "October 17, 2026"
  function longDate(iso, weekday) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: weekday ? 'long' : undefined, month: 'long', day: 'numeric', year: 'numeric' });
  }

  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DATE_IN_TEXT = new RegExp('(20\\d\\d)-(\\d\\d)-(\\d\\d)|\\b(' + MONTH_NAMES.join('|') + ') (\\d{1,2}), (20\\d\\d)\\b', 'g');

  // Every date in a task, either "2026-10-17" or "October 17, 2026", with where it starts
  function datesIn(text) {
    var out = [];
    var m;
    DATE_IN_TEXT.lastIndex = 0;
    while ((m = DATE_IN_TEXT.exec(text))) {
      var iso = m[1] ? m[1] + '-' + m[2] + '-' + m[3]
        : m[6] + '-' + String(MONTH_NAMES.indexOf(m[4]) + 1).padStart(2, '0') + '-' + m[5].padStart(2, '0');
      out.push({ iso: iso, index: m.index });
    }
    return out;
  }

  function whenLabel(iso) {
    var d = daysUntil(iso);
    if (d < 0) return { text: Math.abs(d) + (d === -1 ? ' day late' : ' days late'), soon: true };
    if (d === 0) return { text: 'Today', soon: true };
    if (d === 1) return { text: 'Tomorrow', soon: true };
    return { text: longDate(iso), soon: d <= 7 };
  }

  // ── Render ──

  function render() {
    renderSync();
    renderProblems();
    var s = state.snapshot;
    if (!s) {
      $('roadmap').textContent = '';
      $('roadmap').appendChild(el('p', { className: 'hint', text: 'Waiting for the first sync from your computer. It runs every few minutes while the computer is on.' }));
      return;
    }
    renderGoals();
    renderNextSteps();
    renderTell();
    renderQuestions();
    renderChats();
    renderMoney();
    renderTabs();
    renderRoadmap();
    renderSessions();
    renderWins();
  }

  function renderSync() {
    var s = state.snapshot;
    var node = $('sync-status');
    if (!s) { node.textContent = 'Not synced yet'; node.className = 'sync stale'; return; }
    var stale = Date.now() - Date.parse(s.syncedAt) > 30 * 60000;
    node.className = 'sync' + (stale ? ' stale' : '');
    node.textContent = 'Obsidian synced ' + ago(s.syncedAt) +
      (state.pending ? ' · ' + state.pending + (state.pending === 1 ? ' change' : ' changes') + ' waiting for your computer' : '');
    if (stale) node.textContent += ' (the computer syncs while it’s on)';
  }

  function renderProblems() {
    var box = $('problems');
    box.textContent = '';
    box.hidden = !state.problems.length;
    if (!state.problems.length) return;
    box.appendChild(el('strong', { text: 'Some changes couldn’t be written to Obsidian:' }));
    box.appendChild(el('ul', {}, state.problems.map(function (p) {
      return el('li', { text: '“' + (p.op && p.op.text) + '”: ' + p.reason });
    })));
    box.appendChild(el('button', { className: 'small', text: 'Dismiss', onclick: function () {
      api('home', { method: 'DELETE' }).then(function () { state.problems = []; renderProblems(); });
    } }));
  }

  // ── Direction: the main focus and goals (left), next steps and Claude's questions (middle) ──

  function areaGroups(rm, area) {
    return rm.groups.filter(function (g) { return g.area === area; });
  }

  function directionMap() {
    return state.snapshot.roadmaps.filter(function (r) { return r.direction; })[0];
  }

  function renderGoals() {
    var rm = directionMap();
    $('goals-card').hidden = !rm;
    var box = $('goals');
    box.textContent = '';
    if (!rm) return;
    var d = rm.direction;
    box.appendChild(el('p', { className: 'focus-line' }, [
      el('span', { className: 'eyebrow', text: 'Main focus' }),
      el('span', { html: inline(d.focus || 'Add a **Main focus:** line under Direction in the Road Map') })
    ]));
    if (d.goals.length) box.appendChild(el('ul', { className: 'goals' }, d.goals.map(function (g) { return el('li', { html: inline(g) }); })));
  }

  function renderNextSteps() {
    var rm = directionMap();
    var groups = rm ? areaGroups(rm, 'direction') : [];
    $('next-card').hidden = !groups.length;
    var box = $('next-steps');
    box.textContent = '';
    groups.forEach(function (g) {
      if (groups.length > 1 || !/next steps/i.test(g.heading)) box.appendChild(el('h3', { className: 'steps-head', html: inline(g.heading) }));
      box.appendChild(el('ul', { className: 'tasks' }, g.tasks.map(function (t) { return taskRow(rm, t); })));
      box.appendChild(addRow(rm, g));
    });
  }

  var showAnswered = false;

  function renderQuestions() {
    var qs = [];
    state.snapshot.roadmaps.forEach(function (rm) {
      (rm.questions || []).forEach(function (q) { qs.push({ rm: rm, q: q }); });
    });
    $('questions-card').hidden = !qs.length;
    var box = $('questions');
    box.textContent = '';
    // Answered ones just wait for Claude to file them, so they stay tucked away unless asked for
    var open = qs.filter(function (x) { return !x.q.answers.length; });
    var answered = qs.length - open.length;
    var shown = showAnswered ? qs : open;
    if (shown.length) box.appendChild(questionList(shown));
    else box.appendChild(el('p', { className: 'hint', text: 'All answered. Claude files them next session.' }));
    if (answered) {
      box.appendChild(el('button', { className: 'link questions-more', text: showAnswered ? 'Hide answered' : 'Show ' + answered + ' answered', onclick: function () { showAnswered = !showAnswered; renderQuestions(); } }));
    }
  }

  // ── Tell Claude: Taylor says what's done or changed; Claude rewrites the next steps to match ──

  var tell = { busy: false, result: null };

  function renderTell() {
    var box = $('tell');
    box.textContent = '';
    box.appendChild(tellBox());
  }

  function tellBox() {
    var wrap = el('div', { className: 'tell' });
    if (tell.result) {
      var r = tell.result;
      wrap.appendChild(el('div', { className: 'tell-result' + (r.error ? ' error' : '') }, [
        el('p', { text: r.error ? 'Claude couldn’t update this: ' + r.error : r.reply }),
        r.accomplishments && r.accomplishments.length ? el('p', { className: 'tell-wins', text: 'Added to Accomplishments: ' + r.accomplishments.join('; ') }) : null,
        r.changes && r.changes.length ? el('ul', {}, r.changes.map(function (c) { return el('li', { text: c }); })) : null,
        r.changes && r.changes.length ? el('p', { className: 'hint', text: 'Saved to the Road Map in Obsidian at the next sync.' }) : null,
        el('button', { className: 'link', text: 'OK', onclick: function () { tell.result = null; render(); } })
      ]));
    }
    var area = el('textarea', {
      rows: '2',
      placeholder: 'What you’ve done or what’s changed, e.g. “Applied for the Tait stage tech job. Fixed the bilge pump switch on Cloud 9. Truck is on non-op now.”',
      oninput: function () { drafts.tell = area.value; writing.tell = !!area.value.trim(); }
    });
    area.value = drafts.tell || '';
    area.disabled = tell.busy;
    var send = el('button', { type: 'submit', className: 'small', text: tell.busy ? 'Claude is updating…' : 'Send to Claude' });
    send.disabled = tell.busy;
    var form = el('form', { className: 'tell-form' }, [
      area,
      el('div', { className: 'write-buttons' }, [
        el('span', { className: 'hint', text: 'Claude logs your accomplishments, ticks off what’s done and keeps the next steps small and doable.' }),
        send
      ])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = area.value.trim();
      if (!text || tell.busy) return;
      var jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      tell.busy = true;
      tell.result = null;
      render();
      fetch('/api/update-background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: jobId, text: text }) })
        .then(function (res) { if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); } return pollTell(jobId, 0); })
        .then(function (r) {
          tell.busy = false;
          tell.result = r;
          if (!r.error) { delete drafts.tell; writing.tell = false; }
          return load();
        })
        .catch(function (err) {
          tell.busy = false;
          tell.result = { error: err.message };
          render();
        });
    });
    wrap.appendChild(form);
    return wrap;
  }

  // Claude usually answers in under a minute; give up after four
  function pollTell(jobId, tries) {
    return new Promise(function (resolve) { setTimeout(resolve, 3000); }).then(function () {
      return api('update-result?id=' + jobId);
    }).then(function (r) {
      if (r.done) return r;
      if (tries > 80) throw new Error('Claude took too long. Refresh in a minute to see if the changes came through.');
      return pollTell(jobId, tries + 1);
    });
  }

  // ── Folding: cards marked data-fold shrink to their heading, remembered on this device ──

  function applyFold(node) {
    node.classList.toggle('folded', localGet('fold.' + node.dataset.fold) === '1');
  }

  document.querySelectorAll('[data-fold]').forEach(applyFold);
  document.addEventListener('click', function (e) {
    var head = e.target.closest('[data-fold] > h2, [data-fold] > .card-head > h2, [data-fold] > .section-head > h2');
    if (!head || e.target.closest('a')) return;
    var card = head.closest('[data-fold]');
    card.classList.toggle('folded');
    localSet('fold.' + card.dataset.fold, card.classList.contains('folded') ? '1' : '0');
  });

  function dollars(n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Average over the finished months of the tracker's year, plus this month so far
  function monthlyIncome(inc) {
    var now = new Date();
    var y = now.getFullYear();
    var full = inc.year < y ? 12 : inc.year > y ? 0 : now.getMonth();
    var sum = 0;
    for (var m = 1; m <= full; m++) sum += inc.byMonth[inc.year + '-' + String(m).padStart(2, '0')] || 0;
    var cur = y + '-' + String(now.getMonth() + 1).padStart(2, '0');
    return {
      avg: full ? sum / full : null,
      span: full ? (full === 1 ? 'Jan' : 'Jan to ' + MONTHS[full - 1]) : '',
      thisMonth: inc.year === y ? inc.byMonth[cur] || 0 : null
    };
  }

  function moneyRow(label, value, cls, title) {
    return el('div', { className: 'm-row' + (cls ? ' ' + cls : ''), title: title || null }, [
      el('span', { text: label }), el('span', { className: 'm-val', text: value })
    ]);
  }

  function partsTitle(c) {
    return c.parts.map(function (p) { return p.name + ': ' + dollars(p.monthly); }).join('\n');
  }

  function renderMoney() {
    var m = state.snapshot.money || {};
    var box = $('money');
    box.textContent = '';
    if (!m.personal && !m.business && !m.income) {
      box.appendChild(el('p', { className: 'hint', text: 'Waiting for the next sync to read Living Costs, Overhead and the Revenue Tracker.' }));
      return;
    }
    var need = (m.personal ? m.personal.total : 0) + (m.business ? m.business.total : 0);
    if (m.personal) box.appendChild(moneyRow('To live', dollars(m.personal.total), '', partsTitle(m.personal)));
    if (m.business) box.appendChild(moneyRow('To run the shop', dollars(m.business.total), '', partsTitle(m.business)));
    box.appendChild(moneyRow('Need', dollars(need), 'm-total'));
    if (m.income) {
      var inc = monthlyIncome(m.income);
      if (inc.avg != null) {
        box.appendChild(moneyRow('Coming in (avg ' + inc.span + ')', dollars(inc.avg), 'm-in'));
        var gap = inc.avg - need;
        box.appendChild(moneyRow(gap < 0 ? 'Short by' : 'Ahead by', dollars(Math.abs(gap)), gap < 0 ? 'm-short' : 'm-ahead'));
      }
      if (inc.thisMonth != null) box.appendChild(moneyRow('This month so far', dollars(inc.thisMonth)));
      box.appendChild(el('p', { className: 'm-note', text:
        (m.income.lastPayment ? 'Last payment logged ' + longDate(m.income.lastPayment) + '. ' : 'No payments logged yet. ') +
        'Add payments in the ' + m.income.year + ' Revenue Tracker in Obsidian.' }));
    }
    box.appendChild(el('p', { className: 'm-note', text: 'Before taxes; income is before job materials. Hover a line for its parts.' }));
  }

  // Claude's questions, each with a box to answer; answers go under the question in Obsidian
  function questionList(qs) {
    return el('div', { className: 'questions' }, [
      el('ul', {}, qs.map(function (x) {
        var rm = x.rm;
        var q = x.q;
        var answered = q.answers.length > 0;
        return el('li', { className: answered ? 'answered' : '' }, [
          el('div', { className: 'q', html: inline(q.text) }),
          answered ? el('div', { className: 'a' }, q.answers.map(function (a) { return el('div', { className: 'md', html: block(a) }); })
            .concat([el('p', { className: 'hint', text: 'Claude files this into your notes next session.' })])) : null,
          writeBox(q.key, answered ? 'Add to answer' : 'Answer', 'Your answer', function (text) {
            q.answers.push(text);
            return { type: 'answer', roadmap: rm.id, text: q.text, note: text };
          })
        ]);
      }))
    ]);
  }

  // A link that opens a text box; on save it queues the change the build function returns
  function writeBox(id, label, placeholder, build) {
    if (!writing[id]) {
      return el('button', { className: 'link write', text: label, onclick: function () { writing[id] = true; justOpened = id; render(); } });
    }
    var area = el('textarea', { rows: '3', placeholder: placeholder, oninput: function () { drafts[id] = area.value; } });
    area.value = drafts[id] || '';
    var form = el('form', { className: 'write-box' }, [
      area,
      el('div', { className: 'write-buttons' }, [
        el('button', { type: 'button', className: 'link', text: 'Cancel', onclick: function () { writing[id] = false; delete drafts[id]; render(); } }),
        el('button', { type: 'submit', className: 'small', text: 'Save' })
      ])
    ]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = area.value.trim();
      if (!text) return;
      var body = build(text);
      api('tasks', { method: 'POST', body: body }).then(function () {
        state.pending++;
        writing[id] = false;
        delete drafts[id];
        render();
      }).catch(function (err) { $('sync-status').textContent = 'Not saved: ' + err.message; });
    });
    if (justOpened === id) { justOpened = null; setTimeout(function () { area.focus(); }, 0); }
    return form;
  }

  // ── To do: tasks from every road map, one tab per area of life ──

  var TABS = [
    { id: 'furniture', name: 'LMX Furniture' },
    { id: 'jobs', name: 'Second income' },
    { id: 'financial', name: 'Financial' },
    { id: 'scion', name: 'Scion Forestry' },
    { id: 'personal', name: 'Personal' },
    { id: 'upkeep', name: 'App upkeep' }
  ];

  // Tabs follow the "##" goal a group sits under in the Road Map; teaching counts as LMX Furniture
  function tabOf(rm, g) {
    if (rm.id === 'scion') return 'scion';
    if (rm.id === 'cloud9') return 'personal';
    if (/^Before Next Session/i.test(g.section || '')) return 'upkeep';
    var goal = g.goal || (g.level === 3 ? g.parent : g.heading);
    if (/financ|money|debt/i.test(goal)) return 'financial';
    if (/second income|job/i.test(goal)) return 'jobs';
    if (/scion|forest/i.test(goal)) return 'scion';
    if (/cloud 9|health|life|parked|personal/i.test(goal)) return 'personal';
    return 'furniture';
  }

  // Every to-do group with its road map, minus Next steps (shown at the top)
  function todoGroups(tab) {
    var out = [];
    state.snapshot.roadmaps.forEach(function (rm) {
      rm.groups.forEach(function (g) {
        if (g.area !== 'direction' && (!tab || tabOf(rm, g) === tab)) out.push({ rm: rm, g: g });
      });
    });
    return out;
  }

  function openCount(tab) {
    return todoGroups(tab).reduce(function (n, x) { return n + x.g.tasks.filter(function (t) { return !t.done; }).length; }, 0);
  }

  function renderTabs() {
    var nav = $('roadmap-tabs');
    nav.textContent = '';
    if (!TABS.some(function (t) { return t.id === tabId; })) tabId = TABS[0].id;
    TABS.forEach(function (tab) {
      nav.appendChild(el('button', { className: tab.id === tabId ? 'active' : '', onclick: function () {
        tabId = tab.id;
        localSet('tab', tab.id);
        renderTabs();
        renderRoadmap();
      } }, [tab.name, el('span', { className: 'count', text: String(openCount(tab.id)) })]));
    });
  }

  $('show-done').addEventListener('change', function () {
    localSet('showDone', $('show-done').checked ? '1' : '0');
    renderRoadmap();
  });

  function renderRoadmap() {
    var box = $('roadmap');
    box.textContent = '';
    var showDone = $('show-done').checked;
    var groups = el('div', { className: 'groups' });
    todoGroups(tabId).forEach(function (x) {
      var rm = x.rm;
      var g = x.g;
      var open = g.tasks.filter(function (t) { return !t.done; });
      var done = g.tasks.length - open.length;
      if (!open.length && !showDone) return;
      var card = el('div', { className: 'group' }, [
        g.parent && g.level === 3 ? el('div', { className: 'parent', text: g.parent }) : null,
        el('h3', { html: inline(g.heading) })
      ]);
      var list = el('ul', { className: 'tasks' });
      g.tasks.forEach(function (t) {
        if (t.done && !showDone) return;
        list.appendChild(taskRow(rm, t));
      });
      card.appendChild(list);
      if (done && !showDone) card.appendChild(el('p', { className: 'done-note', text: done + ' done' }));
      card.appendChild(addRow(rm, g));
      groups.appendChild(card);
    });
    if (!groups.children.length) groups.appendChild(el('p', { className: 'hint', text: 'Nothing open here.' }));
    box.appendChild(groups);
  }

  function taskRow(rm, t) {
    var box = el('input', { type: 'checkbox', 'aria-label': 'Done' });
    box.checked = t.done;
    box.addEventListener('change', function () {
      t.done = box.checked;
      row.classList.toggle('done', t.done);
      api('tasks', { method: 'POST', body: { type: 'toggle', roadmap: rm.id, text: t.text, done: t.done } })
        .then(function () { state.pending++; renderSync(); renderTabs(); })
        .catch(function (err) { box.checked = !t.done; t.done = !t.done; $('sync-status').textContent = 'Not saved: ' + err.message; });
    });
    var row = el('li', { className: 'task' + (t.done ? ' done' : '') + (/^pending-/.test(t.key) ? ' pending' : '') }, [
      box,
      el('div', { className: 'body' }, [
        el('span', { className: 'text', html: inline(t.text) }),
        t.sub && t.sub.length ? el('ul', { className: 'sub' }, t.sub.map(function (s) { return el('li', { html: inline(s) }); })) : null,
        writing[t.key] ? writeBox(t.key, '', 'Progress note, e.g. entered 3 past jobs', function (text) {
          var lines = text.split('\n').filter(function (l) { return l.trim(); });
          t.sub = (t.sub || []).concat([longDate(todayIso()) + ': ' + lines[0]], lines.slice(1));
          return { type: 'note', roadmap: rm.id, text: t.text, note: text };
        }) : null
      ]),
      t.done || writing[t.key] ? null : el('button', { className: 'link remind', text: 'Note', title: 'Add a progress note under this task in Obsidian', onclick: function () {
        writing[t.key] = true;
        justOpened = t.key;
        render();
      } }),
      t.done ? null : el('button', { className: 'link remind', text: 'Remind', title: 'Add a reminder to Google Calendar', onclick: function () {
        var date = (datesIn(t.text)[0] || {}).iso;
        openReminder({
          text: t.text.replace(/\*\*|`/g, '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2'),
          date: date && daysUntil(date) >= 0 ? date : todayIso()
        });
      } })
    ]);
    return row;
  }

  function addRow(rm, g) {
    var id = rm.id + '|' + g.heading;
    if (!adding[id]) {
      return el('button', { className: 'link', text: '+ Add task', onclick: function (e) {
        adding[id] = true;
        var row = addRow(rm, g);
        e.target.replaceWith(row);
        row.querySelector('input').focus();
      } });
    }
    var input = el('input', { placeholder: 'New task' });
    var form = el('form', { className: 'add-row' }, [input, el('button', { type: 'submit', className: 'small', text: 'Add' })]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) { adding[id] = false; renderRoadmap(); return; }
      api('tasks', { method: 'POST', body: { type: 'add', roadmap: rm.id, group: g.heading, text: text } }).then(function (r) {
        g.tasks.push({ key: 'pending-' + r.op.id, text: text, done: false, sub: [] });
        state.pending++;
        adding[id] = false;
        renderSync();
        renderTabs();
        renderRoadmap();
      }).catch(function (err) { $('sync-status').textContent = 'Not saved: ' + err.message; });
    });
    return form;
  }

  // ── Calendar: upcoming Google Calendar events, read from its private feed ──

  var calDays = 7;

  function loadCalendar() {
    return api('calendar').then(function (r) {
      state.calendar = r;
      renderCalendar();
    }).catch(function (err) {
      if (err.message === 'Unauthorized') return;
      state.calendar = { error: err.message };
      renderCalendar();
    });
  }

  function isoOf(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function addDays(iso, n) {
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return isoOf(d);
  }

  function dayLabel(iso) {
    var d = daysUntil(iso);
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    return longDate(iso, true);
  }

  function timeLabel(at) {
    return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
  }

  // Each event on every day it touches; all-day end dates are exclusive in the feed
  function eventsByDay(events, first, last) {
    var days = {};
    events.forEach(function (e) {
      var startIso = e.allDay ? e.start.date : isoOf(new Date(e.start.at));
      var endIso = startIso;
      if (e.allDay && e.end && e.end.date) endIso = addDays(e.end.date, -1);
      else if (!e.allDay && e.end && e.end.at) endIso = isoOf(new Date(Date.parse(e.end.at) - 1));
      if (endIso < startIso) endIso = startIso;
      for (var iso = startIso < first ? first : startIso; iso <= endIso && iso <= last; iso = addDays(iso, 1)) {
        (days[iso] = days[iso] || []).push({ ev: e, firstDay: iso === startIso });
      }
    });
    return days;
  }

  function renderCalendar() {
    var box = $('calendar');
    box.textContent = '';
    var c = state.calendar;
    if (!c) { box.appendChild(el('p', { className: 'hint', text: 'Loading…' })); return; }
    if (c.error) { box.appendChild(el('p', { className: 'hint', text: 'Couldn’t load the calendar: ' + c.error })); return; }
    if (!c.configured) {
      box.appendChild(el('div', { className: 'hint', html: block(
        'To show your events here, copy your calendar’s private feed link into Netlify:\n' +
        '1. Google Calendar on a computer, gear icon, **Settings**, then your calendar under "Settings for my calendars"\n' +
        '2. Under "Integrate calendar", copy **Secret address in iCal format**\n' +
        '3. Netlify, site **lmxhome**, Environment variables: add `GCAL_ICS_URLS` with that link (tick "Contains secret values"), then ask Claude to redeploy\n' +
        'More than one calendar: separate the links with commas.') }));
      return;
    }
    var first = todayIso();
    var last = addDays(first, calDays - 1);
    var days = eventsByDay(c.events, first, last);
    var list = el('div', { className: 'cal-days' });
    Object.keys(days).sort().forEach(function (iso) {
      var evs = days[iso].sort(function (a, b) {
        if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
        return (a.ev.start.at || '').localeCompare(b.ev.start.at || '');
      });
      list.appendChild(el('div', { className: 'cal-day' + (iso === first ? ' today' : '') }, [
        el('div', { className: 'cal-date', text: dayLabel(iso) }),
        el('ul', {}, evs.map(function (x) {
          var e = x.ev;
          var t = e.allDay ? 'All day' : (x.firstDay ? timeLabel(e.start.at) : 'cont.');
          return el('li', {}, [
            el('span', { className: 'cal-time', text: t }),
            el('span', { className: 'cal-title', text: e.title + (e.location ? ' · ' + e.location : '') })
          ]);
        }))
      ]));
    });
    if (!list.children.length) list.appendChild(el('p', { className: 'hint', text: 'Nothing on the calendar in the next ' + calDays + ' days.' }));
    box.appendChild(list);
    box.appendChild(el('button', { className: 'link', text: calDays === 7 ? 'Show 2 weeks' : 'Show 1 week', onclick: function () {
      calDays = calDays === 7 ? 14 : 7;
      renderCalendar();
    } }));
    (c.errors || []).forEach(function (e) { box.appendChild(el('p', { className: 'error', text: 'One calendar didn’t load: ' + e })); });
  }

  // ── Reminders: opens Google Calendar with the event filled in ──

  function compact(iso) { return iso.replace(/-/g, ''); }

  function googleLink(text, date, time, notes) {
    var dates;
    if (time) {
      var start = compact(date) + 'T' + time.replace(':', '') + '00';
      var end = new Date(date + 'T' + time + ':00');
      end.setMinutes(end.getMinutes() + 30);
      dates = start + '/' + compact(isoOf(end)) + 'T' + String(end.getHours()).padStart(2, '0') + String(end.getMinutes()).padStart(2, '0') + '00';
    } else {
      dates = compact(date) + '/' + compact(addDays(date, 1));
    }
    var q = 'action=TEMPLATE&text=' + encodeURIComponent(text) + '&dates=' + dates +
      (time ? '&ctz=America/Los_Angeles' : '') +
      (notes ? '&details=' + encodeURIComponent(notes) : '');
    return 'https://calendar.google.com/calendar/render?' + q;
  }

  function openReminder(prefill) {
    prefill = prefill || {};
    $('rem-text').value = prefill.text || '';
    $('rem-date').value = prefill.date || todayIso();
    $('rem-time').value = '';
    $('rem-notes').value = prefill.notes || '';
    var dlg = $('reminder');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    $(prefill.text ? 'rem-date' : 'rem-text').focus();
  }

  function closeReminder() {
    var dlg = $('reminder');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }

  $('new-reminder').addEventListener('click', function () { openReminder(); });
  $('rem-cancel').addEventListener('click', closeReminder);
  $('reminder').addEventListener('click', function (e) { if (e.target === $('reminder')) closeReminder(); });
  $('reminder-form').addEventListener('submit', function (e) {
    e.preventDefault();
    window.open(googleLink($('rem-text').value.trim(), $('rem-date').value, $('rem-time').value, $('rem-notes').value.trim()), '_blank', 'noopener');
    closeReminder();
  });

  // ── Apps ──

  function money(n) { return '$' + (n || 0).toFixed(2); }

  function appLines(a) {
    var d = a.data;
    if (a.error) return [el('div', { className: 'line', text: 'Couldn’t reach it: ' + a.error })];
    if (!d) return [el('div', { className: 'line hint', text: a.up === false ? 'Not responding' : 'Online' })];
    if (a.id === 'opps') {
      var lines = [el('div', { className: 'line', text: d.new + ' new to look through · ' + d.saved + ' saved' + (d.submitted ? ' · ' + d.submitted + ' submitted' : '') })];
      if (d.tabs) lines.push(el('ul', { className: 'opp-tabs' }, d.tabs.map(function (t) { return oppTab(a, t); })));
      else if (d.lastRun) lines.push(el('div', { className: 'line hint', text: 'Last search ' + ago(d.lastRun.finishedAt) + ': ' + d.lastRun.added + ' new, ' + money(d.lastRun.cost) }));
      var busy = (d.tabs || []).filter(function (t) { return t.new >= 15; });
      if (busy.length) lines.push(el('div', { className: 'line nudge', text: 'Rate a few on ' + busy.map(function (t) { return t.name; }).join(' and ') + ' so the search learns what fits.' }));
      return lines;
    }
    if (a.id === 'resume') {
      var r = d.recent && d.recent[0];
      return [el('div', { className: 'line', text: d.count + (d.count === 1 ? ' resume' : ' resumes') + (r ? ' · last edited: ' + r.name + ' (' + ago(r.updatedAt) + ')' : '') })];
    }
    if (a.id === 'flyers') {
      var out = [el('div', { className: 'line', text: d.scansWeek + ' scans this week · ' + d.scansTotal + ' total · ' + d.batches + ' batches' })];
      if (d.topThisWeek && d.topThisWeek.length) out.push(el('div', { className: 'line hint', text: 'Top this week: ' + d.topThisWeek.map(function (t) { return t.name + ' (' + t.scans + ')'; }).join(', ') }));
      return out;
    }
    if (a.id === 'lumber') {
      return [el('div', { className: 'line', text: d.published + ' listings published' }),
        d.published ? null : el('div', { className: 'line nudge', text: 'Publish a listing so it shows on the Lumber Sales page.' })];
    }
    return [];
  }

  // One row per tab of the opportunities app; the name opens the app on that tab
  function oppTab(a, t) {
    var last = t.running ? 'searching now…'
      : t.lastRun ? 'searched ' + ago(t.lastRun.finishedAt) + ': ' + t.lastRun.added + ' new' + (t.lastRun.problems ? ', had a problem' : '')
      : 'not searched yet';
    return el('li', {}, [
      el('a', { href: a.url + '/?tab=' + encodeURIComponent(t.id), target: '_blank', rel: 'noopener', text: t.name }),
      el('span', { className: 'counts', text: t.new + ' new · ' + t.saved + ' saved' }),
      el('div', { className: 'hint' + (t.running ? ' nudge' : ''), text: last + (t.scheduled ? '' : ' · by hand only') })
    ]);
  }

  function renderApps() {
    var box = $('apps');
    box.textContent = '';
    state.apps.forEach(function (a) {
      var bad = Boolean(a.error) || a.up === false;
      box.appendChild(el('div', { className: 'card app' + (a.area === 'Scion Forestry' ? ' forest' : '') }, [
        el('div', { className: 'head' }, [
          el('span', { className: 'dot' + (bad ? ' bad' : ''), title: bad ? 'Problem' : 'Working' }),
          el('a', { href: a.url, target: '_blank', rel: 'noopener', text: a.name }),
          el('span', { className: 'area', text: a.area })
        ])
      ].concat(appLines(a))));
    });
  }

  // ── Recent work ──

  // What Taylor got done, told to Claude in the box at the top (kept in Accomplishments in Obsidian)
  var allWins = false;

  function renderWins() {
    var box = $('wins');
    box.textContent = '';
    var days = state.snapshot.accomplishments || [];
    if (!days.length) {
      box.appendChild(el('p', { className: 'hint', text: 'Tell Claude what you’ve done and it shows up here.' }));
      return;
    }
    var count = 0;
    days.forEach(function (d) { count += d.items.length; });
    (allWins ? days : days.slice(0, 4)).forEach(function (d) {
      box.appendChild(el('h3', { className: 'win-day', text: d.date }));
      box.appendChild(el('ul', { className: 'wins' }, d.items.map(function (i) { return el('li', { html: inline(i) }); })));
    });
    if (days.length > 4) {
      box.appendChild(el('button', { className: 'link', text: allWins ? 'Show fewer' : 'Show all ' + count, onclick: function () { allWins = !allWins; renderWins(); } }));
    }
  }

  // Past "Tell Claude" exchanges (Updates from LMX Home in Obsidian)
  var allChats = false;

  function renderChats() {
    var chats = state.snapshot.chats || [];
    $('chats-card').hidden = !chats.length;
    var box = $('chats');
    box.textContent = '';
    (allChats ? chats : chats.slice(0, 2)).forEach(function (c) {
      box.appendChild(el('div', { className: 'chat' }, [
        el('div', { className: 'chat-date', text: c.date }),
        el('p', {}, [el('strong', { text: 'You: ' }), el('span', { html: inline(c.you) })]),
        c.claude ? el('p', {}, [el('strong', { text: 'Claude: ' }), el('span', { html: inline(c.claude) })]) : null,
        c.changes && c.changes.length ? el('details', {}, [
          el('summary', { text: c.changes.length + (c.changes.length === 1 ? ' change' : ' changes') }),
          el('ul', {}, c.changes.map(function (x) { return el('li', { html: inline(x) }); }))
        ]) : null
      ]));
    });
    if (chats.length > 2) {
      box.appendChild(el('button', { className: 'link', text: allChats ? 'Show fewer' : 'Show all ' + chats.length, onclick: function () { allChats = !allChats; renderChats(); } }));
    }
  }

  function renderSessions() {
    var box = $('sessions');
    box.textContent = '';
    state.snapshot.sessions.slice(0, 3).forEach(function (s) {
      var items = s.items.slice(0, 6);
      box.appendChild(el('div', { className: 'session' }, [
        el('h3', { text: s.title.replace(/^Session,\s*/, '') }),
        s.wrap ? el('p', { html: inline(s.wrap) }) : null,
        items.length ? el('ul', {}, items.map(function (i) { return el('li', { html: inline(i) }); })) : null
      ]));
    });
    box.appendChild(el('p', { className: 'hint', text: 'Older sessions are in Session Summary in Obsidian.' }));
  }

  // Keep it fresh while it's open: road maps every 2 minutes, app numbers and calendar every 10
  // (skipped while a note or answer box is open, so nothing typed gets lost)
  setInterval(function () { if (!$('app').hidden && !document.hidden && !Object.keys(writing).some(function (k) { return writing[k]; })) load(); }, 120000);
  setInterval(function () { if (!$('app').hidden && !document.hidden) { loadApps(); loadCalendar(); } }, 600000);

  fetch('/api/auth-check').then(function (res) {
    if (res.ok) start(); else showLogin();
  }).catch(showLogin);
})();

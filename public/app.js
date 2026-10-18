(function () {
  'use strict';

  var state = { snapshot: null, pending: 0, problems: [], apps: null, cleared: [], calendar: null };
  var showCleared = false;
  var roadmapId = localGet('roadmap') || 'woodworking';
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

  function inline(s) {
    return escapeHtml(s)
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
      state.cleared = r.cleared || [];
      render();
    }).catch(function (err) {
      if (err.message !== 'Unauthorized') $('sync-status').textContent = err.message;
    });
  }

  function loadApps() {
    return api('apps').then(function (apps) {
      state.apps = apps;
      renderApps();
      renderComingUp();
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

  function shortDate(iso) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function whenLabel(iso) {
    var d = daysUntil(iso);
    if (d < 0) return { text: Math.abs(d) + (d === -1 ? ' day late' : ' days late'), soon: true };
    if (d === 0) return { text: 'Today', soon: true };
    if (d === 1) return { text: 'Tomorrow', soon: true };
    return { text: shortDate(iso), soon: d <= 7 };
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
    renderDirection();
    renderAgendas();
    renderTabs();
    renderRoadmap();
    renderSessions();
    renderComingUp();
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

  // ── Direction: the main focus, goals, next steps, money each month and Claude's questions ──

  function areaGroups(rm, area) {
    return rm.groups.filter(function (g) { return g.area === area; });
  }

  function areaQuestions(rm, area) {
    return (rm.questions || []).filter(function (q) { return q.area === area; });
  }

  function renderDirection() {
    var box = $('direction');
    box.textContent = '';
    var rm = state.snapshot.roadmaps.filter(function (r) { return r.direction; })[0];
    box.hidden = !rm;
    if (!rm) return;
    var d = rm.direction;
    var main = el('div', { className: 'dir-main' }, [
      el('div', { className: 'eyebrow', text: 'Direction' }),
      el('h2', { className: 'focus-line', html: inline(d.focus || 'Add a **Main focus:** line under Direction in the Road Map') }),
      d.goals.length ? el('ul', { className: 'goals' }, d.goals.map(function (g) { return el('li', { html: inline(g) }); })) : null
    ]);
    areaGroups(rm, 'direction').forEach(function (g) {
      main.appendChild(el('h3', { className: 'steps-head', html: inline(g.heading) }));
      main.appendChild(el('ul', { className: 'tasks' }, g.tasks.map(function (t) { return taskRow(rm, t); })));
      main.appendChild(addRow(rm, g));
    });
    box.appendChild(el('div', { className: 'dir-grid' }, [main, moneyPanel()]));
    var qs = questionList(rm, areaQuestions(rm, 'direction'));
    if (qs) box.appendChild(qs);
  }

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

  function moneyPanel() {
    var m = state.snapshot.money || {};
    var box = el('aside', { className: 'dir-money' }, [el('h3', { text: 'Each month' })]);
    if (!m.personal && !m.business && !m.income) {
      box.appendChild(el('p', { className: 'hint', text: 'Waiting for the next sync to read Living Costs, Overhead and the Revenue Tracker.' }));
      return box;
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
        (m.income.lastPayment ? 'Last payment logged ' + shortDate(m.income.lastPayment) + '. ' : 'No payments logged yet. ') +
        'Add payments in the ' + m.income.year + ' Revenue Tracker in Obsidian.' }));
    }
    box.appendChild(el('p', { className: 'm-note', text: 'Before taxes; income is before job materials. Hover a line for its parts.' }));
    return box;
  }

  // Claude's questions, each with a box to answer; answers go under the question in Obsidian
  function questionList(rm, qs) {
    if (!qs.length) return null;
    return el('div', { className: 'questions' }, [
      el('h3', { text: 'Claude asks' }),
      el('ul', {}, qs.map(function (q) {
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

  function renderAgendas() {
    var box = $('agendas');
    box.textContent = '';
    state.snapshot.roadmaps.forEach(function (rm) {
      var tasks = [];
      areaGroups(rm, 'agenda').forEach(function (g) { tasks = tasks.concat(g.tasks); });
      var qs = areaQuestions(rm, 'agenda');
      if (!rm.agenda || (!rm.agenda.text && !tasks.length && !qs.length)) return;
      var showDone = $('show-done').checked;
      var open = tasks.filter(function (t) { return !t.done; });
      box.appendChild(el('section', { className: 'card agenda' }, [
        el('h2', { text: rm.agenda.title + (state.snapshot.roadmaps.length > 1 ? ' · ' + rm.name : '') }),
        tasks.length ? el('ul', { className: 'tasks' }, tasks.filter(function (t) { return showDone || !t.done; }).map(function (t) { return taskRow(rm, t); })) : null,
        tasks.length > open.length && !showDone ? el('p', { className: 'done-note', text: (tasks.length - open.length) + ' done' }) : null,
        rm.agenda.text ? el('div', { className: 'md', html: block(rm.agenda.text) }) : null,
        questionList(rm, qs)
      ]));
    });
  }

  function openCount(rm) {
    return rm.groups.reduce(function (n, g) { return g.area ? n : n + g.tasks.filter(function (t) { return !t.done; }).length; }, 0);
  }

  function renderTabs() {
    var nav = $('roadmap-tabs');
    nav.textContent = '';
    if (!state.snapshot.roadmaps.some(function (r) { return r.id === roadmapId; })) roadmapId = state.snapshot.roadmaps[0].id;
    state.snapshot.roadmaps.forEach(function (rm) {
      nav.appendChild(el('button', { className: rm.id === roadmapId ? 'active' : '', onclick: function () {
        roadmapId = rm.id;
        localSet('roadmap', rm.id);
        renderTabs();
        renderRoadmap();
      } }, [rm.name, el('span', { className: 'count', text: String(openCount(rm)) })]));
    });
  }

  $('show-done').addEventListener('change', function () {
    localSet('showDone', $('show-done').checked ? '1' : '0');
    renderAgendas();
    renderRoadmap();
  });

  function renderRoadmap() {
    var rm = state.snapshot.roadmaps.filter(function (r) { return r.id === roadmapId; })[0];
    var box = $('roadmap');
    box.textContent = '';
    var showDone = $('show-done').checked;
    var groups = el('div', { className: 'groups' });
    rm.groups.forEach(function (g) {
      if (g.area) return; // shown in the Direction and agenda cards
      var open = g.tasks.filter(function (t) { return !t.done; });
      var done = g.tasks.length - open.length;
      if (!open.length && !showDone) return;
      var card = el('div', { className: 'card group' }, [
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
    if (rm.completedCount) box.appendChild(el('p', { className: 'done-note', text: rm.completedCount + ' more in the Completed list in Obsidian.' }));
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
          t.sub = (t.sub || []).concat([todayIso() + ': ' + lines[0]], lines.slice(1));
          return { type: 'note', roadmap: rm.id, text: t.text, note: text };
        }) : null
      ]),
      t.done || writing[t.key] ? null : el('button', { className: 'link remind', text: 'Note', title: 'Add a progress note under this task in Obsidian', onclick: function () {
        writing[t.key] = true;
        justOpened = t.key;
        render();
      } }),
      t.done ? null : el('button', { className: 'link remind', text: 'Remind', title: 'Add a reminder to Google Calendar', onclick: function () {
        var date = /(20\d\d-\d\d-\d\d)/.exec(t.text);
        openReminder({
          text: t.text.replace(/\*\*|`/g, '').replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2'),
          date: date && daysUntil(date[1]) >= 0 ? date[1] : todayIso()
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

  // ── Coming up: deadlines from the apps plus dated tasks ──

  // Dates in a task count when the wording points ahead ("by", "on or after", "tomorrow"...)
  var AHEAD = /(by|on|before|after|revisit|due|tomorrow|deadline|until)\b[^.]{0,30}$/i;

  function datedTasks() {
    var out = [];
    (state.snapshot ? state.snapshot.roadmaps : []).forEach(function (rm) {
      rm.groups.forEach(function (g) {
        g.tasks.forEach(function (t) {
          if (t.done) return;
          var re = /(20\d\d-\d\d-\d\d)/g;
          var m;
          while ((m = re.exec(t.text))) {
            var before = t.text.slice(0, m.index).replace(/\*\*/g, '');
            var d = daysUntil(m[1]);
            if ((d >= 0 && d <= 30) || (d < 0 && d >= -21 && AHEAD.test(before))) {
              out.push({ date: m[1], text: t.text.replace(/\*\*/g, ''), src: rm.name });
              break;
            }
          }
        });
      });
    });
    return out;
  }

  // The date is part of the key, so a deadline that moves comes back
  function itemKey(it) { return it.src + '|' + it.date + '|' + it.text; }

  function isCleared(it) {
    var k = itemKey(it);
    return state.cleared.some(function (c) { return c.key === k; });
  }

  function setCleared(it, clear) {
    var k = itemKey(it);
    var before = state.cleared;
    state.cleared = clear ? before.concat([{ key: k, text: it.text }]) : before.filter(function (c) { return c.key !== k; });
    renderComingUp();
    api('cleared', { method: clear ? 'POST' : 'DELETE', body: { key: k, text: it.text } })
      .then(function (r) { state.cleared = r.cleared; renderComingUp(); })
      .catch(function (err) { state.cleared = before; renderComingUp(); $('sync-status').textContent = 'Not saved: ' + err.message; });
  }

  $('show-cleared').addEventListener('click', function () { showCleared = !showCleared; renderComingUp(); });

  function renderComingUp() {
    var items = datedTasks();
    (state.apps || []).forEach(function (a) {
      ((a.data && a.data.deadlines) || []).forEach(function (d) {
        items.push({ date: d.deadline, text: d.title + (d.organization ? ' (' + d.organization + ')' : ''), src: d.tab || a.name, url: d.url, status: d.status });
      });
    });
    items.sort(function (a, b) { return a.date.localeCompare(b.date); });
    var clearedHere = items.filter(isCleared);
    var shown = showCleared ? items : items.filter(function (it) { return !isCleared(it); });
    var toggle = $('show-cleared');
    toggle.hidden = !clearedHere.length;
    toggle.textContent = showCleared ? 'Hide cleared' : 'Show cleared (' + clearedHere.length + ')';
    var list = $('coming-up');
    list.textContent = '';
    shown.slice(0, showCleared ? 40 : 12).forEach(function (it) {
      var w = whenLabel(it.date);
      var cleared = isCleared(it);
      list.appendChild(el('li', { className: cleared ? 'cleared' : '' }, [
        el('span', { className: 'when' + (w.soon && !cleared ? ' soon' : ''), text: w.text }),
        el('span', { className: 'what' }, [
          it.url ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.text }) : el('span', { html: inline(it.text) }),
          it.status ? ' · ' + it.status : '',
          el('span', { className: 'src', text: ' ' + it.src })
        ]),
        el('span', { className: 'item-actions' }, [
          cleared ? null : el('button', { className: 'link', text: 'Remind', title: 'Add a reminder to Google Calendar', onclick: function () {
            openReminder({ text: it.text.replace(/\*\*/g, ''), date: daysUntil(it.date) < 0 ? todayIso() : it.date, notes: it.url || '' });
          } }),
          el('button', { className: 'link', text: cleared ? 'Restore' : 'Clear', title: cleared ? 'Show it in Coming up again' : 'Hide it from Coming up', onclick: function () { setCleared(it, !cleared); } })
        ])
      ]));
    });
    if (!shown.length) {
      var msg = !state.apps ? 'Loading deadlines…'
        : items.length ? 'All cleared.'
        : 'Nothing dated in the next month. Deadlines appear here once you mark an opportunity Interested or Applying and give it a deadline.';
      list.appendChild(el('li', { className: 'hint', text: msg }));
    }
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
    return shortDate(iso);
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

  function renderSessions() {
    var box = $('sessions');
    box.textContent = '';
    state.snapshot.sessions.slice(0, 3).forEach(function (s) {
      var items = s.items.slice(0, 6);
      box.appendChild(el('div', { className: 'session card' }, [
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

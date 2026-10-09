(function () {
  'use strict';

  var state = { snapshot: null, pending: 0, problems: [], apps: null };
  var roadmapId = localGet('roadmap') || 'woodworking';
  var adding = {}; // group heading -> add box open

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

  $('refresh').addEventListener('click', function () { load(); loadApps(); });

  function start() {
    $('login').hidden = true;
    $('app').hidden = false;
    $('today').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    $('show-done').checked = localGet('showDone') === '1';
    load();
    loadApps();
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
    $('focus').hidden = !s.focus;
    $('focus').innerHTML = '<strong>Business plan focus:</strong> ' + inline(s.focus || '');
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

  function renderAgendas() {
    var box = $('agendas');
    box.textContent = '';
    state.snapshot.roadmaps.forEach(function (rm) {
      if (!rm.agenda || !rm.agenda.text) return;
      box.appendChild(el('section', { className: 'card agenda' }, [
        el('h2', { text: rm.agenda.title + (state.snapshot.roadmaps.length > 1 ? ' · ' + rm.name : '') }),
        el('div', { className: 'md', html: block(rm.agenda.text) })
      ]));
    });
  }

  function openCount(rm) {
    return rm.groups.reduce(function (n, g) { return n + g.tasks.filter(function (t) { return !t.done; }).length; }, 0);
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
    renderRoadmap();
  });

  function renderRoadmap() {
    var rm = state.snapshot.roadmaps.filter(function (r) { return r.id === roadmapId; })[0];
    var box = $('roadmap');
    box.textContent = '';
    var showDone = $('show-done').checked;
    var groups = el('div', { className: 'groups' });
    rm.groups.forEach(function (g) {
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
        t.sub && t.sub.length ? el('ul', { className: 'sub' }, t.sub.map(function (s) { return el('li', { html: inline(s) }); })) : null
      ])
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

  function renderComingUp() {
    var items = datedTasks();
    (state.apps || []).forEach(function (a) {
      ((a.data && a.data.deadlines) || []).forEach(function (d) {
        items.push({ date: d.deadline, text: d.title + (d.organization ? ' (' + d.organization + ')' : ''), src: a.name, url: d.url, status: d.status });
      });
    });
    items.sort(function (a, b) { return a.date.localeCompare(b.date); });
    var list = $('coming-up');
    list.textContent = '';
    items.slice(0, 12).forEach(function (it) {
      var w = whenLabel(it.date);
      list.appendChild(el('li', {}, [
        el('span', { className: 'when' + (w.soon ? ' soon' : ''), text: w.text }),
        el('span', { className: 'what' }, [
          it.url ? el('a', { href: it.url, target: '_blank', rel: 'noopener', text: it.text }) : el('span', { html: inline(it.text) }),
          it.status ? ' · ' + it.status : ''
        ]),
        el('span', { className: 'src', text: it.src })
      ]));
    });
    if (!items.length) list.appendChild(el('li', { className: 'hint', text: state.apps ? 'Nothing dated in the next month. Deadlines appear here once you mark an opportunity Interested or Applying and give it a deadline.' : 'Loading deadlines…' }));
  }

  // ── Apps ──

  function money(n) { return '$' + (n || 0).toFixed(2); }

  function appLines(a) {
    var d = a.data;
    if (a.error) return [el('div', { className: 'line', text: 'Couldn’t reach it: ' + a.error })];
    if (!d) return [el('div', { className: 'line hint', text: a.up === false ? 'Not responding' : 'Online' })];
    if (a.id === 'opps' || a.id === 'scion') {
      var lines = [el('div', { className: 'line', text: d.new + ' new to look through · ' + d.saved + ' saved' + (d.submitted ? ' · ' + d.submitted + ' submitted' : '') })];
      if (d.running) lines.push(el('div', { className: 'line nudge', text: 'Searching right now…' }));
      else if (d.lastRun) lines.push(el('div', { className: 'line hint', text: 'Last search ' + ago(d.lastRun.finishedAt) + ': ' + d.lastRun.added + ' new, ' + money(d.lastRun.cost) }));
      if (d.new >= 15) lines.push(el('div', { className: 'line nudge', text: 'Rate a few so the search learns what fits.' }));
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

  // Keep it fresh while it's open: road maps every 2 minutes, app numbers every 10
  setInterval(function () { if (!$('app').hidden && !document.hidden) load(); }, 120000);
  setInterval(function () { if (!$('app').hidden && !document.hidden) loadApps(); }, 600000);

  fetch('/api/auth-check').then(function (res) {
    if (res.ok) start(); else showLogin();
  }).catch(showLogin);
})();

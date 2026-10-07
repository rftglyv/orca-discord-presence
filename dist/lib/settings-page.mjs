/**
 * The settings page served by `settings-server.mts`. Self-contained (no
 * external requests — the CSP forbids them), and every value from the API is
 * written with `textContent` / `.value`, never parsed as HTML.
 *
 * The embedded script avoids template literals so this file can hold it in
 * one TypeScript template string without escaping.
 */
export const SETTINGS_PAGE_HTML = String.raw `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord Presence settings</title>
<style>
  :root {
    --bg: #1e1f22; --panel: #2b2d31; --panel-2: #313338; --line: #3f4147;
    --text: #f2f3f5; --muted: #b5bac1; --faint: #80848e;
    --accent: #5865f2; --green: #23a55a; --amber: #f0b232; --red: #f23f43;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 "gg sans", "Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 16px 24px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 2;
  }
  header img { width: 28px; height: 28px; border-radius: 7px; }
  header h1 { font-size: 16px; margin: 0; flex: 1; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: var(--panel-2); color: var(--muted); }
  .pill.on { color: #fff; background: var(--green); }
  .pill.off { color: #fff; background: var(--red); }
  main {
    display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px;
    max-width: 1080px; margin: 0 auto; padding: 24px;
  }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } aside { order: -1; } }
  section { background: var(--panel); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  section h2 {
    margin: 0 0 12px; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; }
  .row + .row { border-top: 1px solid var(--line); }
  .row label { flex: 1; }
  .row label.switch { flex: none; }
  .row small { display: block; color: var(--faint); font-size: 12px; }
  input[type=text], input[type=url], input[type=number], select, textarea {
    background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    padding: 7px 9px; font: inherit; min-width: 0;
  }
  input[type=text], input[type=url], input[type=number], select { height: 36px; }
  input[type=text], input[type=url] { width: 240px; }
  input[type=number] { width: 96px; }
  select {
    -webkit-appearance: none; appearance: none; width: 180px; padding: 0 34px 0 11px; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23b5bac1' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 11px center;
  }
  select:hover, input:hover, textarea:hover { border-color: #4e5058; }
  select option { background: var(--panel); color: var(--text); }
  textarea { width: 100%; min-height: 160px; resize: vertical; margin-top: 8px; }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .switch { position: relative; width: 40px; height: 24px; flex: none; display: inline-block; cursor: pointer; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch span {
    position: absolute; inset: 0; border-radius: 999px; background: var(--faint); cursor: pointer; transition: background .15s;
  }
  .switch span::after {
    content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; transition: transform .15s;
  }
  .switch input:checked + span { background: var(--green); }
  .switch input:checked + span::after { transform: translateX(16px); }
  .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.ghost {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 6px;
    padding: 5px 12px; font: inherit; font-size: 13px; cursor: pointer;
  }
  button.ghost:hover { background: var(--line); }
  button.ghost:disabled { opacity: .6; cursor: progress; }
  button.link { background: none; border: 0; color: #00a8fc; cursor: pointer; padding: 0; font: inherit; }
  aside { position: sticky; top: 84px; align-self: start; }
  .card { background: var(--panel); border-radius: 10px; padding: 14px; }
  .card .kind { font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 10px; }
  .act { display: flex; gap: 12px; }
  .art { position: relative; width: 88px; height: 88px; flex: none; }
  .art .large { width: 88px; height: 88px; border-radius: 10px; }
  .art .small {
    position: absolute; right: -5px; bottom: -5px; width: 30px; height: 30px; border-radius: 50%;
    border: 4px solid var(--panel);
  }
  .lines { min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
  .lines .name { font-weight: 700; }
  .lines div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lines .faint { color: var(--muted); font-size: 13px; }
  .btns { margin-top: 12px; display: grid; gap: 8px; }
  .btns div { background: var(--panel-2); border-radius: 6px; text-align: center; padding: 8px; font-weight: 600; }
  .hint { color: var(--faint); font-size: 12px; margin-top: 10px; }
  .empty { color: var(--muted); padding: 24px 0; text-align: center; }
  .member { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .member b { color: var(--text); }
  #toast {
    position: fixed; bottom: 20px; left: 50%; transform: translate(-50%, 20px); opacity: 0;
    background: var(--green); color: #fff; padding: 8px 16px; border-radius: 8px; transition: all .2s; pointer-events: none;
  }
  #toast.show { opacity: 1; transform: translate(-50%, 0); }
  #toast.err { background: var(--red); }
  .stats { margin: 6px 0 0; padding-left: 18px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <img src="/art/orca.png" alt="">
  <h1>Discord Presence</h1>
  <span id="conn" class="pill">…</span>
  <button id="reconnect" class="ghost" type="button">Reconnect</button>
</header>
<main>
  <div>
    <section>
      <h2>Card</h2>
      <div class="row"><label for="enabled">Show my activity on Discord</label>
        <label class="switch"><input type="checkbox" id="enabled" data-key="enabled" data-default="true"><span></span></label></div>
      <div class="row"><label for="privacy">Privacy<small>Full shows workspace and branch names; minimal shows counts only.</small></label>
        <select id="privacy" data-key="privacy"><option value="full">Full</option><option value="minimal">Minimal</option><option value="off">Off</option></select></div>
      <div class="row"><label for="statusLine">Line next to your name in member lists</label>
        <select id="statusLine" data-key="statusLine"><option value="state">Fleet status</option><option value="details">Tagline / header</option><option value="name">App name</option></select></div>
    </section>

    <section>
      <h2>Top line</h2>
      <div class="row"><label for="taglines">Rotate fun taglines<small>Otherwise the header below is shown.</small></label>
        <label class="switch"><input type="checkbox" id="taglines" data-key="taglines" data-default="true"><span></span></label></div>
      <div class="row"><label for="header">Header<small>Use {workspace} and {branch}; shown in the logo's hover text while taglines rotate.</small></label>
        <input type="text" id="header" data-key="header" placeholder="Orca" maxlength="128"></div>
      <div class="row" style="display:block">
        <label for="customTaglines">My taglines<small>One per line, 2–128 characters. Leave empty to use the 50 built-in ones. <button class="link" id="loadDefaults" type="button">Start from the built-in list</button></small></label>
        <textarea id="customTaglines" spellcheck="false"></textarea>
      </div>
    </section>

    <section>
      <h2>Bottom line</h2>
      <div class="row"><label for="showStats">Rotate today's and all-time stats<small>Tasks finished and agent time, between live status updates.</small></label>
        <label class="switch"><input type="checkbox" id="showStats" data-key="showStats" data-default="true"><span></span></label></div>
      <div class="row"><label for="rotateSeconds">Change every (seconds)<small>20 minimum — Discord rate-limits updates.</small></label>
        <input type="number" id="rotateSeconds" data-key="rotateSeconds" min="20" max="3600" placeholder="45"></div>
      <ul class="stats" id="statsList"></ul>
    </section>

    <section>
      <h2>Images &amp; button</h2>
      <div class="row"><label for="badge">Status badge on the logo</label>
        <select id="badge"><option value="auto">Follows the fleet</option><option value="off">Hidden</option></select></div>
      <div class="row"><label for="largeText">Logo hover text<small>Empty uses the header.</small></label>
        <input type="text" id="largeText" data-key="largeText" placeholder="(automatic)" maxlength="128"></div>
      <div class="row"><label for="btnOn">Show a link button<small>Discord shows buttons to others, never to you.</small></label>
        <label class="switch"><input type="checkbox" id="btnOn"><span></span></label></div>
      <div class="row"><label for="btnLabel">Button text</label><input type="text" id="btnLabel" maxlength="32" placeholder="Get Orca"></div>
      <div class="row"><label for="btnUrl">Button link</label><input type="url" id="btnUrl" placeholder="https://onorca.dev"></div>
    </section>

    <section>
      <h2>When idle</h2>
      <div class="row"><label for="idleClearMinutes">Clear the card after (minutes idle)<small>0 keeps the idle card up.</small></label>
        <input type="number" id="idleClearMinutes" data-key="idleClearMinutes" min="0" max="1440" placeholder="15"></div>
    </section>

    <section>
      <h2>Advanced</h2>
      <div class="row"><label for="clientId">Discord application ID<small>Empty uses the plugin's own app.</small></label>
        <input type="text" id="clientId" data-key="clientId" placeholder="(built-in)" inputmode="numeric"></div>
    </section>
  </div>

  <aside>
    <div class="card">
      <div class="kind">Playing Orca ADE</div>
      <div id="preview"></div>
      <div class="member" id="member"></div>
    </div>
    <p class="hint">Live preview of what Discord shows. It refreshes every few seconds and rotates like the real card.</p>
  </aside>
</main>
<div id="toast" role="status"></div>

<script>
'use strict'
var token = '__SETTINGS_TOKEN__'
var state = null
var saveTimer = null
var pending = {}

function $(id) { return document.getElementById(id) }

function api(method, path, body) {
  return fetch(path, {
    method: method,
    headers: { 'X-Settings-Token': token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.json()
  })
}

function toast(text, isError) {
  var el = $('toast')
  el.textContent = text
  el.className = isError ? 'show err' : 'show'
  clearTimeout(toast.timer)
  toast.timer = setTimeout(function () { el.className = isError ? 'err' : '' }, 1600)
}

function queue(key, value) {
  pending[key] = value
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 450)
}

function flush() {
  var patch = pending
  pending = {}
  api('POST', '/api/settings', patch).then(function (next) {
    state = next
    renderPreview()
    toast('Saved')
  }).catch(function (error) { toast('Could not save: ' + error.message, true) })
}

function el(tag, className, text) {
  var node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function elapsed(start) {
  var seconds = Math.max(0, Math.floor((Date.now() - start) / 1000))
  var h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60
  var pad = function (n) { return (n < 10 ? '0' : '') + n }
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s) + ' elapsed'
}

function renderPreview() {
  var box = $('preview')
  box.textContent = ''
  var conn = $('conn')
  conn.textContent = state.connected ? 'Connected to Discord' : 'Not connected to Discord'
  conn.className = 'pill ' + (state.connected ? 'on' : 'off')
  conn.title = state.connected ? '' : (state.lastError || 'Is the Discord desktop app running?')

  var stats = $('statsList')
  stats.textContent = ''
  state.stats.forEach(function (line) { stats.appendChild(el('li', '', line)) })

  var a = state.preview
  if (!a) {
    var why = !state.enabled
      ? 'Nothing is shown: "Show my activity" is off.'
      : state.settings.privacy === 'off'
        ? 'Nothing is shown: privacy is set to Off.'
        : 'Nothing is shown: the fleet has been idle, so the card was cleared. It comes back when an agent starts working.'
    box.appendChild(el('div', 'empty', why))
    $('member').textContent = ''
    return
  }
  var act = el('div', 'act')
  if (a.assets && a.assets.large_image) {
    var art = el('div', 'art')
    var large = el('img', 'large'); large.src = '/art/' + a.assets.large_image + '.png'; large.alt = ''
    large.title = a.assets.large_text || ''
    large.onerror = function () { large.style.visibility = 'hidden' }
    art.appendChild(large)
    if (a.assets.small_image) {
      var small = el('img', 'small'); small.src = '/art/' + a.assets.small_image + '.png'; small.alt = ''
      small.title = a.assets.small_text || ''
      small.onerror = function () { small.style.visibility = 'hidden' }
      art.appendChild(small)
    }
    act.appendChild(art)
  }
  var lines = el('div', 'lines')
  lines.appendChild(el('div', 'name', 'Orca ADE'))
  if (a.details) lines.appendChild(el('div', '', a.details))
  if (a.state) {
    var party = a.party && a.party.size ? ' (' + a.party.size[0] + ' of ' + a.party.size[1] + ')' : ''
    lines.appendChild(el('div', '', a.state + party))
  }
  if (a.timestamps && a.timestamps.start) {
    var timer = el('div', 'faint', elapsed(a.timestamps.start))
    timer.dataset.start = a.timestamps.start
    lines.appendChild(timer)
  }
  act.appendChild(lines)
  box.appendChild(act)
  if (a.buttons && a.buttons.length) {
    var btns = el('div', 'btns')
    a.buttons.forEach(function (b) { btns.appendChild(el('div', '', b.label)) })
    box.appendChild(btns)
  }
  var member = $('member')
  member.textContent = ''
  var line = a.status_display_type === 1 ? a.state : a.status_display_type === 2 ? a.details : 'Orca ADE'
  member.appendChild(el('span', '', 'In member lists: '))
  member.appendChild(el('b', '', 'Playing ' + (line || 'Orca ADE')))
}

function fillForm() {
  var s = state.settings
  Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (input) {
    var value = s[input.dataset.key]
    if (input.type === 'checkbox') {
      input.checked = value === undefined || value === null ? input.dataset.default === 'true' : value !== false
    } else if (input.tagName === 'SELECT') {
      if (value !== undefined && value !== null) input.value = value
      else input.selectedIndex = input.id === 'privacy' ? 1 : 0
    } else {
      input.value = value === undefined || value === null ? '' : value
    }
  })
  $('badge').value = s.smallImage === '' ? 'off' : 'auto'
  $('customTaglines').value = Array.isArray(s.customTaglines) ? s.customTaglines.join('\n') : ''
  var buttons = s.buttons
  var first = Array.isArray(buttons) && buttons[0] ? buttons[0] : null
  $('btnOn').checked = !(buttons === false || (Array.isArray(buttons) && buttons.length === 0))
  $('btnLabel').value = first ? first.label : ''
  $('btnUrl').value = first ? first.url : ''
}

function wire() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (input) {
    var key = input.dataset.key
    var handler = function () {
      if (input.type === 'checkbox') return queue(key, input.checked)
      if (input.type === 'number') return queue(key, input.value === '' ? null : Number(input.value))
      var text = input.value.trim()
      // Empty text resets the setting to its default (the placeholder shows it).
      queue(key, text === '' ? null : text)
    }
    input.addEventListener(input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input', handler)
  })
  $('badge').addEventListener('change', function () { queue('smallImage', this.value === 'off' ? '' : null) })
  $('customTaglines').addEventListener('input', function () {
    var lines = this.value.split('\n').map(function (l) { return l.trim() }).filter(Boolean)
    queue('customTaglines', lines.length ? lines : null)
  })
  var buttonChange = function () {
    if (!$('btnOn').checked) return queue('buttons', [])
    var label = $('btnLabel').value.trim(), url = $('btnUrl').value.trim()
    queue('buttons', label || url ? [{ label: label || 'Get Orca', url: url || 'https://onorca.dev' }] : null)
  }
  ;['btnOn', 'btnLabel', 'btnUrl'].forEach(function (id) {
    $(id).addEventListener(id === 'btnOn' ? 'change' : 'input', buttonChange)
  })
  $('reconnect').addEventListener('click', function () {
    var button = this
    button.disabled = true
    button.textContent = 'Connecting…'
    api('POST', '/api/reconnect').then(function (next) {
      state = next
      renderPreview()
      toast(state.connected ? 'Connected to Discord' : 'Could not connect: ' + (state.lastError || 'is Discord running?'), !state.connected)
    }).catch(function (error) { toast('Reconnect failed: ' + error.message, true) })
      .then(function () { button.disabled = false; button.textContent = 'Reconnect' })
  })
  $('loadDefaults').addEventListener('click', function () {
    $('customTaglines').value = state.defaultTaglines.join('\n')
    $('customTaglines').dispatchEvent(new Event('input'))
  })
}

function refresh() {
  return api('GET', '/api/state').then(function (next) {
    var changed = JSON.stringify(next.settings) !== JSON.stringify(state.settings)
    state = next
    // Another tab, or an Orca command, changed something: show it — unless
    // the user is mid-edit here, where overwriting their typing would be worse.
    var editing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)
    if (changed && !editing) fillForm()
    renderPreview()
  })
}

api('GET', '/api/state').then(function (first) {
  state = first
  fillForm()
  wire()
  renderPreview()
  setInterval(function () { if (!Object.keys(pending).length) refresh().catch(function () {}) }, 5000)
  setInterval(function () {
    var timer = document.querySelector('[data-start]')
    if (timer) timer.textContent = elapsed(Number(timer.dataset.start))
  }, 1000)
}).catch(function () {
  document.querySelector('main').textContent = 'This link has expired. Run "Discord Presence: Open Settings" in Orca again.'
})
</script>
</body>
</html>
`;
//# sourceMappingURL=settings-page.mjs.map
'use strict'
const $ = (id) => document.getElementById(id)
const palette = ['#b7f4cf', '#b6caff', '#efc1ff', '#ffd392', '#9de0ed', '#f7b4aa']
let token = location.hash.slice(1) || sessionStorage.getItem('aidcrew-token') || ''
if (location.hash) history.replaceState(null, '', location.pathname)
if (token) sessionStorage.setItem('aidcrew-token', token)
let state,
  selected = '',
  view = 'mission',
  reasoning = false,
  tab = 'conversation',
  lastFeed = '',
  lastRoster = '',
  connected = false
let modalSubmit,
  toastTimer,
  inspected,
  inspectionPending = false,
  lastInspection = 0,
  detailsSignature = ''
let cachedState,
  stateTag = '',
  sending = false
const drafts = new Map()
const voice = (id) =>
  palette[Math.max(0, state?.agents.findIndex((a) => a.id === id) ?? 0) % palette.length]
const money = (n) => (n === undefined ? '—' : `$${n.toFixed(n < 1 ? 4 : 2)}`)
const node = (tag, text, cls) => {
  const el = document.createElement(tag)
  if (text !== undefined) el.textContent = text
  if (cls) el.className = cls
  return el
}
const button = (text, action, cls = 'subtle') => {
  const el = node('button', text, cls)
  el.type = 'button'
  el.onclick = action
  return el
}
function toast(text) {
  $('toast').textContent = text
  $('toast').hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => ($('toast').hidden = true), 5000)
}
async function api(path, data) {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(path === '/api/state' && stateTag ? { 'If-None-Match': stateTag } : {}),
      ...(data
        ? { 'Content-Type': 'application/json', 'X-AIDCrew-Session': state?.sessionId || '' }
        : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
    signal: AbortSignal.timeout(data ? 120000 : 15000),
  })
  if (response.status === 304) return cachedState
  if (path === '/api/state' && response.ok) stateTag = response.headers.get('ETag') || ''
  const body = await response.json()
  if (path === '/api/state' && response.ok) cachedState = body
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
async function act(action) {
  const requestSession = state?.sessionId
  try {
    const body = await api('/api/action', action)
    if (requestSession !== state?.sessionId && action.type !== 'open' && action.type !== 'agentDefinition')
      throw new Error(
        'Workspace changed while the request was running. Its result belongs to the previous session.',
      )
    return body.result
  } catch (e) {
    toast(e.message)
    throw e
  }
}
function perform(action, done) {
  void act(action)
    .then((result) => {
      if (done) done(result)
    })
    .catch(() => {})
}
function choose(id) {
  drafts.set(selected, $('message').value)
  selected = id
  $('message').value = drafts.get(id) || ''
  lastFeed = ''
  lastRoster = ''
  render()
}
function field(label, name, value = '', type = 'text') {
  const el = node('label', label)
  const input = node(name === 'paths' ? 'textarea' : 'input')
  input.name = name
  input.value = value
  input.type = type
  input.required = true
  el.append(input)
  return el
}
function dialog(title, nodes, submit, label = 'Continue') {
  $('modal-title').textContent = title
  $('modal-body').replaceChildren(...nodes)
  $('modal-submit').hidden = !submit
  $('modal-submit').textContent = label
  modalSubmit = submit
  $('modal').showModal()
}
$('modal-close').onclick = () => $('modal').close()
$('modal-form').onsubmit = async (e) => {
  e.preventDefault()
  if (!modalSubmit) return
  $('modal-submit').disabled = true
  try {
    await modalSubmit(new FormData(e.currentTarget))
    $('modal').close()
  } catch {
  } finally {
    $('modal-submit').disabled = false
  }
}
function authenticate() {
  dialog(
    'Connect to your crew',
    [
      node(
        'p',
        'Paste the session access token from the private web access file shown in your terminal. Your browser and terminal control the same agents.',
      ),
      field('Access token', 'token', '', 'password'),
    ],
    async (data) => {
      token = String(data.get('token'))
      sessionStorage.setItem('aidcrew-token', token)
      await api('/api/state')
    },
    'Connect',
  )
}
function help() {
  dialog('Make yourself at home.', [
    node(
      'p',
      'Shortcuts light up when used. Letter shortcuts stay out of your way while you are typing.',
    ),
    ...[
      ['J / K', 'Next / previous agent'],
      ['/', 'Focus the composer'],
      ['R', 'Toggle reasoning'],
      ['⌘ / Ctrl + Enter', 'Send message'],
      ['Escape', 'Stop selected agent (outside text fields)'],
      ['?', 'This shortcut guide'],
    ].map(([key, text]) => {
      const row = node('p', text)
      row.prepend(node('kbd', key))
      return row
    }),
  ])
}
$('help').onclick = help
$('shortcuts').onclick = help
function highlight(key, el) {
  const targets = [...document.querySelectorAll(`[data-shortcut="${key}"]`), ...(el ? [el] : [])]
  for (const t of targets) {
    t.classList.add('shortcut-hit')
    setTimeout(() => t.classList.remove('shortcut-hit'), 700)
  }
}
function showView(next) {
  view = next
  tab = 'conversation'
  lastFeed = ''
  inspected = undefined
  detailsSignature = ''
  document
    .querySelectorAll('[data-view]')
    .forEach((el) => el.classList.toggle('active', el.dataset.view === view))
  render()
  if (['memory', 'tasks', 'settings'].includes(view)) inspect()
}
for (const el of document.querySelectorAll('[data-view]'))
  el.onclick = () => showView(el.dataset.view)
$('conversation-tab').onclick = () => {
  tab = 'conversation'
  render()
}
$('diff-tab').onclick = () => {
  tab = 'diff'
  render()
  perform({ type: 'diff', agent: selected }, (result) => {
    $('details').replaceChildren(node('pre', result || 'No uncommitted changes.'))
    $('details').append(button('Merge verified work', () => confirmMerge()))
  })
}
function confirmMerge() {
  dialog(
    'Merge this task',
    [
      node(
        'p',
        'Run the configured verification and merge this agent’s task into the repository. The same checks and conflict handling used by the terminal apply.',
      ),
    ],
    () => act({ type: 'merge', agent: selected }).then((result) => toast(JSON.stringify(result))),
    'Verify and merge',
  )
}
$('thinking').onclick = () => {
  reasoning = !reasoning
  lastFeed = ''
  render()
}
$('stop').onclick = () => perform({ type: 'cancel', agent: selected })
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(
      state.lines
        .filter((l) => l.agentId === selected && l.kind === 'say')
        .map((l) => l.text)
        .join('\n\n'),
    )
    toast('Agent replies copied')
  } catch {
    toast('Clipboard access is unavailable in this browser')
  }
}
$('spawn').onclick = () =>
  dialog(
    'Grow your crew',
    [
      field('Existing role', 'role', state?.agents[0]?.role || 'coder'),
      node(
        'p',
        'A new agent gets the tools and instructions of this role, through the existing harness runtime.',
      ),
    ],
    (data) =>
      act({ type: 'spawn', role: String(data.get('role')) }).then((id) => {
        selected = id
        lastRoster = ''
      }),
    'Spawn agent',
  )
$('switch-project').onclick = () =>
  dialog(
    'Open workspace',
    [
      field('Absolute project path', 'cwd', state?.cwd || ''),
      node(
        'p',
        'This switches the shared workspace in both interfaces. Current agents shut down through the normal session lifecycle.',
      ),
    ],
    (data) => act({ type: 'open', cwd: String(data.get('cwd')) }),
    'Open workspace',
  )
$('composer').onsubmit = async (e) => {
  e.preventDefault()
  const text = $('message').value.trim()
  if (!text || !connected || !state?.ready || sending) return
  sending = true
  const agent = selected
  $('send').disabled = true
  try {
    await act(
      text.startsWith('/') ? { type: 'command', agent, text } : { type: 'send', agent, text },
    )
    if (selected === agent && $('message').value.trim() === text) $('message').value = ''
    drafts.delete(agent)
  } catch {
  } finally {
    sending = false
    $('send').disabled = !connected || !state?.ready
  }
}
document.addEventListener('keydown', (e) => {
  if ($('modal').open) return
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    highlight('send', $('send'))
    $('composer').requestSubmit()
    return
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === 'j' || e.key === 'k') {
    e.preventDefault()
    const list = state?.agents || []
    if (list.length)
      choose(
        list[
          (list.findIndex((a) => a.id === selected) + (e.key === 'j' ? 1 : list.length - 1)) %
            list.length
        ].id,
      )
    highlight(e.key)
  }
  if (e.key === '/') {
    e.preventDefault()
    $('message').focus()
    highlight('/')
  }
  if (e.key === 'r') {
    $('thinking').click()
    highlight('r', $('thinking'))
  }
  if (e.key === '?') help()
  if (e.key === 'Escape' && state?.ready) {
    $('stop').click()
    highlight('stop', $('stop'))
  }
})
function avatar(id, label) {
  const el = node('span', label || id.slice(0, 2).toUpperCase(), 'avatar')
  el.style.setProperty('--voice', voice(id))
  return el
}
function renderRoster() {
  const signature = JSON.stringify([state.agents, selected])
  if (signature === lastRoster) return
  lastRoster = signature
  $('roster').replaceChildren()
  $('cards').replaceChildren()
  $('agent-count').textContent = state.agents.length
  for (const a of state.agents) {
    const busy = !['idle', 'stopped', 'failed'].includes(a.status)
    const row = button('', () => choose(a.id), `roster-item${selected === a.id ? ' selected' : ''}`)
    const label = node('span')
    label.append(node('b', a.id), node('small', a.status))
    row.append(avatar(a.id), label, node('i', undefined, `status-dot${busy ? ' busy' : ''}`))
    $('roster').append(row)
    const card = button('', () => choose(a.id), `agent-card${selected === a.id ? ' selected' : ''}`)
    card.style.setProperty('--voice', voice(a.id))
    card.setAttribute('aria-pressed', String(selected === a.id))
    const top = node('div', undefined, 'card-top')
    top.append(avatar(a.id), node('b', a.id), node('span', a.status, 'card-status'))
    const bottom = node('div', undefined, 'card-bottom')
    bottom.append(
      node('span', `${a.turns} turns · ${a.queued} queued`),
      node('b', `${a.estimated && a.cost !== undefined ? '≈ ' : ''}${money(a.cost)}`),
    )
    card.append(top, node('div', a.model, 'model'), bottom)
    $('cards').append(card)
  }
}
// Render a small Markdown subset with DOM nodes only; model output is never HTML.
function richText(text) {
  const container = node('div', undefined, 'entry-content')
  const sections = text.split(/(```[\s\S]*?```)/g)
  for (const section of sections) {
    if (section.startsWith('```')) {
      const pre = node('pre')
      pre.append(node('code', section.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')))
      container.append(pre)
      continue
    }
    for (const paragraph of section.split(/\n\n+/).filter(Boolean)) {
      const p = node('p')
      for (const part of paragraph.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
        if (part.startsWith('**') && part.endsWith('**'))
          p.append(node('strong', part.slice(2, -2)))
        else if (part.startsWith('`') && part.endsWith('`'))
          p.append(node('code', part.slice(1, -1)))
        else p.append(document.createTextNode(part))
      }
      container.append(p)
    }
  }
  return container
}
function renderFeed() {
  const all = view === 'activity'
  const lines = state.lines.filter(
    (l) => (all || l.agentId === selected) && (reasoning || l.kind !== 'thinking'),
  )
  const signature = JSON.stringify([selected, lines])
  if (lastFeed === signature) return
  lastFeed = signature
  const feed = $('feed'),
    atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90,
    previous = feed.scrollTop
  const fragment = document.createDocumentFragment()
  if (!lines.length) {
    const empty = node('div', undefined, 'empty')
    empty.append(
      node(
        'strong',
        state.ready ? 'A blank canvas. A capable crew.' : 'Your session will appear here.',
      ),
      node(
        'p',
        state.ready
          ? 'Give an agent a direction below to begin.'
          : 'Open a project in the terminal. This page reconnects automatically.',
      ),
    )
    fragment.append(empty)
  }
  for (const l of lines.slice(-400)) {
    const el = node('article', undefined, `entry ${l.kind}`)
    el.append(avatar(l.agentId, l.kind === 'ask' ? 'YOU' : undefined))
    const content = node('div')
    const head = node('div', undefined, 'entry-head')
    head.append(node('b', l.kind === 'ask' ? 'You' : l.agentId), node('span', l.kind))
    content.append(head, l.kind === 'say' ? richText(l.text) : node('div', l.text, 'entry-content'))
    el.append(content)
    fragment.append(el)
  }
  feed.replaceChildren(fragment)
  feed.scrollTop = atBottom ? feed.scrollHeight : previous
}
let pendingId = ''
function renderApproval() {
  const p = state.pending
  $('approval').hidden = !p
  if (!p || pendingId === p.id) return
  pendingId = p.id
  $('approval').replaceChildren(
    node('strong', `${p.agentId} needs your decision`),
    node('p', `${p.because}\n${p.summary}`),
  )
  for (const a of p.answers)
    $('approval').append(
      button(
        `${a.label} [${a.key}]`,
        () => perform({ type: 'answer', request: p.id, key: a.key }),
        a.tone === 'bad' ? 'subtle danger' : 'subtle',
      ),
    )
}
async function inspect() {
  if (inspectionPending || !state) return
  inspectionPending = true
  try {
    inspected = await act({ type: 'inspect' })
    lastInspection = Date.now()
    renderDetails()
  } catch {
  } finally {
    inspectionPending = false
  }
}
function editModel(agent) {
  const modelField = field('Model ID', 'model', agent.model)
  const providerField = field('Provider', 'provider', agent.provider || 'openrouter')
  const input = modelField.querySelector('input')
  const provider = providerField.querySelector('input')
  const options = node('datalist')
  options.id = 'available-models'
  input.setAttribute('list', options.id)
  const status = node('p', 'Loading the provider’s model catalogue…')
  dialog(
    `Model for ${agent.id}`,
    [
      providerField,
      modelField,
      options,
      status,
      node('p', 'Saved to project configuration. Takes effect on the next turn.'),
    ],
    (data) =>
      act({
        type: 'model',
        agent: agent.id,
        model: String(data.get('model')),
        provider: String(data.get('provider')),
      }),
    'Save model',
  )
  const load = async () => {
    const wanted = provider.value.trim()
    if (!wanted) return
    try {
      const names = await act({ type: 'models', provider: wanted })
      if (provider.value.trim() !== wanted) return
      options.replaceChildren(
        ...(Array.isArray(names) ? names : []).map((name) => {
          const option = node('option')
          option.value = name
          return option
        }),
      )
      status.textContent = names?.length
        ? `${names.length} models available. Start typing to filter.`
        : 'Catalogue unavailable. Enter a model ID manually.'
    } catch {
      status.textContent = 'Catalogue unavailable. Enter a model ID manually.'
    }
  }
  provider.onchange = load
  void load()
}
function editDefinition(definition = {}) {
  const prompt = node('label', 'System instructions')
  const area = node('textarea')
  area.name = 'systemPrompt'
  area.rows = 8
  area.required = true
  area.value = definition.systemPrompt || ''
  area.style.width = '100%'
  prompt.append(area)
  dialog(
    definition.id ? `Edit ${definition.id}` : 'Define a new agent',
    [
      field('Role ID', 'id', definition.id || ''),
      field('Description', 'description', definition.description || ''),
      prompt,
      node(
        'p',
        'New roles join the live team. Edited system instructions are read on the next session start.',
      ),
    ],
    (d) =>
      act({
        type: 'agentDefinition',
        id: String(d.get('id')),
        description: String(d.get('description')),
        systemPrompt: String(d.get('systemPrompt')),
        ...(definition.tools ? { tools: definition.tools } : {}),
      }).then(() => inspect()),
    'Save role',
  )
}
function renderDetails() {
  if (!['tasks', 'memory', 'settings'].includes(view)) return
  const signature = JSON.stringify([
    view,
    inspected,
    state.memory,
    state.sharedMemory,
    state.agents.map((a) => [a.id, a.model, a.yolo]),
    state.plugins,
  ])
  if (signature === detailsSignature) return
  detailsSignature = signature
  const el = $('details')
  el.replaceChildren()
  if (view === 'tasks') {
    el.append(
      button('＋ New task', () =>
        dialog(
          'Start a parallel task',
          [
            field('Task name', 'name'),
            field(
              'Roles (comma separated)',
              'roles',
              [...new Set(state.agents.map((a) => a.role))].join(', '),
            ),
          ],
          (data) =>
            act({
              type: 'task',
              name: String(data.get('name')),
              roles: String(data.get('roles'))
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }).then(() => inspect()),
          'Start task',
        ),
      ),
    )
    for (const task of inspected?.tasks || []) {
      const row = node('div', undefined, 'settings-row')
      row.append(node('pre', JSON.stringify(task, null, 2)))
      el.append(row)
    }
    if (!inspected?.tasks?.length) el.append(node('p', 'No task records to display.'))
  }
  if (view === 'memory') {
    el.append(
      node('h3', 'A shared understanding.'),
      node(
        'p',
        state.sharedMemory
          ? 'Shared memory is enabled. Notes below come from the session journal.'
          : 'Shared memory is paused. Saved notes are retained.',
      ),
      button(state.sharedMemory ? 'Pause shared memory' : 'Enable shared memory', () =>
        perform({ type: 'memory', on: !state.sharedMemory }, () => inspect()),
      ),
    )
    for (const [task, memory] of Object.entries(state.memory || inspected?.memory || {}))
      el.append(node('h4', task), node('pre', JSON.stringify(memory, null, 2)))
  }
  if (view === 'settings') {
    el.append(node('h3', 'Your team. Your choice of models.'))
    for (const a of state.agents) {
      const row = node('div', undefined, 'settings-row')
      row.append(
        avatar(a.id),
        node('strong', a.id),
        node('span', `${a.provider || ''} / ${a.model}`, 'quiet'),
      )
      row.append(button('Model', () => editModel(a)))
      row.append(
        button(a.yolo ? 'YOLO on' : 'Ask first', () =>
          dialog(
            'Agent autonomy',
            [
              node(
                'p',
                a.yolo
                  ? 'Require approval for guarded operations again.'
                  : 'Allow this agent to execute tools without asking, including irreversible shell commands. This applies to this session.',
              ),
            ],
            () => act({ type: 'yolo', agent: a.id, on: !a.yolo }),
            'Apply',
          ),
        ),
      )
      row.append(
        button('Clear queue', () => perform({ type: 'clearQueue', agent: a.id })),
        button('Reset history', () =>
          dialog(
            'Reset conversation',
            [
              node(
                'p',
                'Forget this idle agent’s conversation. Stop the agent first if a turn is running.',
              ),
            ],
            () => act({ type: 'forget', agent: a.id }),
            'Reset',
          ),
        ),
        button(
          'Remove',
          () =>
            dialog(
              'Remove agent',
              [node('p', 'The normal harness worktree rules apply. Unmerged work is preserved.')],
              () => act({ type: 'kill', agent: a.id }),
              'Remove',
            ),
          'subtle danger',
        ),
      )
      el.append(row)
    }
    el.append(node('h3', 'Plugins'))
    for (const p of state.plugins) {
      const row = node('div', undefined, 'settings-row')
      row.append(
        node('strong', p.name),
        node('span', `${p.version || ''} · ${p.tools.length} tools`, 'quiet'),
      )
      el.append(row)
    }
    el.append(
      node('h3', 'Agent definitions'),
      button('＋ Create a role', () => editDefinition()),
    )
    for (const definition of inspected?.definitions || []) {
      const row = node('div', undefined, 'settings-row')
      row.append(
        node('strong', definition.id),
        button('Edit instructions', () => editDefinition(definition)),
        button(
          'Delete definition',
          () =>
            dialog(
              'Delete saved role',
              [
                node(
                  'p',
                  'This removes the role from the project. Running agents of this role must be removed first.',
                ),
              ],
              () => act({ type: 'removeDefinition', id: definition.id }).then(() => inspect()),
              'Delete',
            ),
          'subtle danger',
        ),
      )
      el.append(row)
    }
    el.append(
      node('h3', 'Provider credentials'),
      node('p', 'Keys are write-only here and saved by the existing credential store.'),
      button('Save API key', () =>
        dialog(
          'Provider API key',
          [
            field(
              'Credential scope (for example provider:openrouter)',
              'scope',
              'provider:openrouter',
            ),
            field('API key', 'key', '', 'password'),
          ],
          (d) =>
            act({ type: 'credentials', scope: String(d.get('scope')), key: String(d.get('key')) }),
          'Save key',
        ),
      ),
    )
    for (const credential of inspected?.credentials || []) {
      const row = node('div', undefined, 'settings-row')
      row.append(
        node('strong', credential.scope),
        node('span', credential.hint || 'saved', 'quiet'),
        button(
          'Forget key',
          () =>
            dialog(
              'Forget saved credential',
              [
                node(
                  'p',
                  `Remove ${credential.scope} from the credential store. Existing environment variables are unaffected.`,
                ),
              ],
              () =>
                act({ type: 'forgetCredential', scope: credential.scope }).then(() => inspect()),
              'Forget key',
            ),
          'subtle danger',
        ),
      )
      el.append(row)
    }
    el.append(
      button('Set default model', () =>
        dialog(
          'Default provider and model',
          [
            field('Provider', 'provider', inspected?.defaults?.provider || ''),
            field('Model', 'model', inspected?.defaults?.model || ''),
          ],
          async (d) => {
            await act({ type: 'default', setting: 'provider', value: String(d.get('provider')) })
            await act({ type: 'default', setting: 'model', value: String(d.get('model')) })
            await inspect()
          },
          'Save defaults',
        ),
      ),
    )
    el.append(node('h3', 'Project sources'))
    for (const source of inspected?.sources || [])
      el.append(
        button(source.label, () =>
          dialog(
            `Sources: ${source.label}`,
            [field('Paths (one per line)', 'paths', source.paths.join('\n'))],
            (d) =>
              act({
                type: 'sources',
                kind: source.label,
                paths: String(d.get('paths')).split('\n').filter(Boolean),
              }).then(() => inspect()),
            'Save paths',
          ),
        ),
      )
    el.append(node('h3', 'Terminal appearance'))
    el.append(
      button('Hairline', () => perform({ type: 'appearance', fill: 'hairline' })),
      button('Solid', () => perform({ type: 'appearance', fill: 'solid' })),
      button('Hide terminal paths', () => perform({ type: 'appearance', hidePaths: true })),
      button('Show terminal paths', () => perform({ type: 'appearance', hidePaths: false })),
    )
    for (const name of state.themes)
      el.append(
        button(name, () => perform({ type: 'theme', name }, () => toast('Terminal theme updated'))),
      )
    el.append(
      node(
        'p',
        'The composer accepts the same slash commands as the terminal. Provider credentials remain in the harness credential store.',
      ),
    )
  }
}
function render() {
  if (!state) return
  if (!state.agents.some((a) => a.id === selected)) {
    drafts.set(selected, $('message').value)
    selected = state.target || state.agents[0]?.id || ''
    $('message').value = drafts.get(selected) || ''
  }
  $('project').textContent = state.cwd.split('/').filter(Boolean).pop() || 'Workspace'
  $('path').textContent = state.cwd
  $('cost').textContent = money(state.total)
  $('cost-note').textContent = state.agents.some((a) => a.estimated)
    ? 'Includes list-price estimates'
    : 'Reported usage'
  $('recipient').textContent = selected || 'your crew'
  const agent = state.agents.find((a) => a.id === selected)
  $('queue-label').textContent = agent?.queued ? `${agent.queued} waiting` : ''
  $('footer-status').textContent =
    `${state.agents.length} agents · ${state.outstanding} handoffs outstanding · memory ${state.sharedMemory ? 'on' : 'off'}`
  $('live').textContent = connected
    ? state.ready
      ? 'LIVE SESSION'
      : 'WAITING FOR SESSION'
    : 'DISCONNECTED'
  $('send').disabled = sending || !connected || !state.ready
  $('stop').disabled = !connected || !agent
  const names = {
    mission: 'Mission control',
    activity: 'Activity',
    tasks: 'Tasks & worktrees',
    memory: 'Shared memory',
    settings: 'Team & plugins',
  }
  $('view-label').textContent = names[view]
  $('heading').textContent = view === 'mission' ? 'Your crew, in motion.' : names[view]
  $('thinking').setAttribute('aria-pressed', String(reasoning))
  $('conversation-tab').classList.toggle('active', tab === 'conversation')
  $('diff-tab').classList.toggle('active', tab === 'diff')
  const detail = ['tasks', 'memory', 'settings'].includes(view) || tab === 'diff'
  $('feed').hidden = detail
  $('details').hidden = !detail
  renderRoster()
  renderApproval()
  if (!detail) renderFeed()
  else if (tab !== 'diff') renderDetails()
}
async function poll() {
  try {
    if (!token) {
      if (!$('modal').open) authenticate()
      return
    }
    const next = await api('/api/state')
    if (state && next.sessionId !== state.sessionId) {
      $('modal').close()
      modalSubmit = undefined
      drafts.clear()
      selected = ''
      $('message').value = ''
      inspected = undefined
      lastFeed = ''
      lastRoster = ''
      detailsSignature = ''
      toast('Workspace changed. Your browser is now connected to the new session.')
    }
    state = next
    connected = true
    $('connection').textContent = 'Connected · synced with TUI'
    $('connection-dot').className = 'online'
    render()
    if (['tasks', 'memory', 'settings'].includes(view) && Date.now() - lastInspection > 6000)
      void inspect()
  } catch (e) {
    connected = false
    $('connection').textContent = 'Disconnected · retrying'
    $('connection-dot').className = ''
    $('live').textContent = 'DISCONNECTED'
    $('send').disabled = true
    $('stop').disabled = true
    if (e.message === 'Authentication required' && !$('modal').open) authenticate()
  } finally {
    setTimeout(poll, 750)
  }
}
void poll()

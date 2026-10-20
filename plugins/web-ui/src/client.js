import { initSettings } from './settings-client.js'
import { initMemoryGraph } from './memory-graph-client.js'
import { initOverview } from './overview-client.js'
import { initTiling } from './tiling-client.js'
import { initQuickChat } from './quick-chat-client.js'
import { initActivity } from './activity-client.js'
'use strict'
import { agentAvatar } from './agent-avatar.js'
import { initTeamViews } from './team-graph-client.js'
import { selectFeed } from './feed.js'
import { crewPulse } from './crew-pulse.js'
import { initPalette } from './palette.js'
import { taskCards } from './tasks.js'
import { taskText } from './task-text.js'
import { initNativeTerminal } from './native-client.js'
import { nativeText } from './native-text.js'
import { commandText, crewText, feedText, workspaceText } from './ui-text.js'
const $ = (id) => document.getElementById(id)
/**
 * Which part of a change a row is. The same four markers as `diffClass` in
 * protocol.ts, which is tested; this file is served as text and cannot
 * import it.
 */
const diffClass = (row) => {
  const mark = row.slice(0, 1)
  if (mark === '+') return 'add'
  if (mark === '-') return 'del'
  if (mark === '~') return 'head'
  return 'ctx'
}
const palette = ['#b7f4cf', '#b6caff', '#efc1ff', '#ffd392', '#9de0ed', '#f7b4aa']
let token = location.hash.slice(1) || sessionStorage.getItem('aidcrew-token') || ''
if (location.hash) history.replaceState(null, '', location.pathname)
if (token) sessionStorage.setItem('aidcrew-token', token)
let state,
  selected = '',
  view = 'overview',
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
let feedQuery = '',
  feedFilter = 'all',
  resetFeedPosition = true
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
  if (tab === 'native') { nativeTerminal.close(); tab = 'conversation' }
  drafts.set(selected, $('message').value)
  selected = id
  $('message').value = drafts.get(id) || ''
  lastFeed = ''
  lastRoster = ''
  resetFeedPosition = true
  render()
}
function field(label, name, value = '', type = 'text') {
  const el = node('label', label)
  const input = node(name === 'paths' ? 'textarea' : 'input')
  input.name = name
  input.value = value
  if (input instanceof HTMLInputElement) input.type = type
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
      ['F', feedText.searchHelp],
      ['⌘ / Ctrl + K', commandText.guide],
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
  if (tab === 'native') nativeTerminal.close()
  view = next === 'activity' ? 'overview' : next
  tab = 'conversation'
  lastFeed = ''
  resetFeedPosition = true
  inspected = undefined
  detailsSignature = ''
  document
    .querySelectorAll('[data-view]')
    .forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view)
      if (el.dataset.view === view) el.setAttribute('aria-current', 'page')
      else el.removeAttribute('aria-current')
    })
  render()
  if (['memory', 'tasks', 'settings'].includes(view)) inspect()
}
for (const el of document.querySelectorAll('[data-view]')) {
  const label = workspaceText.views[el.dataset.view]
  el.querySelector('.nav-label').textContent = label
  el.title = label
  el.setAttribute('aria-label', label)
  if (el.dataset.view === view) el.setAttribute('aria-current', 'page')
  if (['mission', 'graph', 'grid'].includes(el.dataset.view)) el.dataset.teamView = el.dataset.view
  el.onclick = () => showView(el.dataset.view)
}
$('help-label').textContent = workspaceText.help
$('sidebar-toggle').textContent = workspaceText.workspace
$('conversation-tab').onclick = () => {
  if (tab === 'native') nativeTerminal.close()
  tab = 'conversation'
  render()
}
$('diff-tab').onclick = () => {
  if (tab === 'native') nativeTerminal.close()
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
  resetFeedPosition = true
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
  if (nativePane.contains(document.activeElement)) return
  if ($('modal').open) return
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (view !== 'mission') return
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
    if (view !== 'mission') showView('mission')
    $('message').focus()
    highlight('/')
  }
  if (e.key === 'f' && !$('feed-tools').hidden) {
    e.preventDefault()
    $('feed-search').focus()
  }
  if (e.key === 'r') {
    $('thinking').click()
    highlight('r', $('thinking'))
  }
  if (e.key === '?') help()
  if (e.key === 'Escape' && state?.ready && view === 'mission') {
    $('stop').click()
    highlight('stop', $('stop'))
  }
})
function avatar(id, label) {
  const identity = agentAvatar(id, state?.agents.find((agent) => agent.id === id)?.role || id)
  const el = node('span', undefined, 'avatar')
  el.style.setProperty('--voice', identity.color)
  el.title = identity.label
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 7 7')
  svg.setAttribute('aria-hidden', 'true')
  const background = document.createElementNS(svg.namespaceURI, 'rect')
  for (const [key, value] of Object.entries({width: 7, height: 7, rx: 1.3, fill: identity.background})) background.setAttribute(key, String(value))
  svg.append(background)
  for (const cell of identity.cells) {
    const rect = document.createElementNS(svg.namespaceURI, 'rect')
    for (const [key, value] of Object.entries({x: cell.x + 1, y: cell.y + 1, width: .85, height: .85, rx: .15, fill: identity.color})) rect.setAttribute(key, String(value))
    svg.append(rect)
  }
  el.append(svg)
  if (label) { el.setAttribute('aria-label', label); el.append(node('small', label, 'avatar-label')) }
  return el
}
const teamSurface = node('section', undefined, 'team-surface')
teamSurface.id = 'team-surface'
teamSurface.hidden = true
$('workspace').before(teamSurface)
const teamViews = initTeamViews({ host: teamSurface, avatar, choose: (id) => { showView('mission'); choose(id) } })
const tilingSurface = node('section', undefined, 'tiling-surface')
tilingSurface.id = 'tiling-surface'
tilingSurface.hidden = true
$('workspace').before(tilingSurface)
const tiling = initTiling({
  host: tilingSurface,
  avatar,
  choose: (id) => { showView('mission'); choose(id) },
  send: (agent, text) => act({ type: 'send', agent, text }),
})
const activitySurface = node('section', undefined, 'activity-surface')
activitySurface.id = 'activity-surface'
activitySurface.hidden = true
$('workspace').before(activitySurface)
const overviewWorkspace = node('section', undefined, 'session-overview')
overviewWorkspace.id = 'overview-workspace'
$('overview-surface').before(overviewWorkspace)
overviewWorkspace.append($('overview-surface'), activitySurface)
const activityView = initActivity({ host: activitySurface, avatar, choose: (id) => { showView('mission'); choose(id) } })
const chatHost = node('aside')
document.body.append(chatHost)
const quickChat = initQuickChat({
  host: chatHost,
  launcherHost: document.querySelector('.top-actions'),
  send: (agent, text) => act({ type: 'send', agent, text }),
  choose: (id) => { showView('mission'); choose(id) },
})
const overview = initOverview({
  host: $('overview-surface'),
  avatar,
  choose: (id) => { showView('mission'); choose(id) },
  showView,
})
function renderRoster() {
  const signature = JSON.stringify([state.agents, selected, state.pending?.agentId])
  if (signature === lastRoster) return
  lastRoster = signature
  $('cards').replaceChildren()
  for (const a of state.agents) {
    const card = button('', () => choose(a.id), `agent-card${selected === a.id ? ' selected' : ''}`)
    card.style.setProperty('--voice', voice(a.id))
    card.setAttribute('role', 'tab')
    card.setAttribute('aria-selected', String(selected === a.id))
    card.setAttribute('aria-controls', 'workspace')
    card.tabIndex = selected === a.id ? 0 : -1
    card.title = `${a.model} · ${a.turns} turns · ${a.queued} queued · ${money(a.cost)}`
    const top = node('div', undefined, 'card-top')
    top.append(avatar(a.id), node('b', a.id), node('span', a.status, 'card-status'))
    card.append(top, node('div', a.model, 'model'))
    const reason = crewPulse([a], state.pending?.agentId).attention[0]?.reason
    if (reason) {
      const badge = node('span', crewText.reason[reason], 'agent-attention')
      if (reason === 'behind') badge.title = crewText.behind(a.behind)
      card.append(badge)
    }
    $('cards').append(card)
  }
}
const pulse = node('div', undefined, 'crew-pulse')
pulse.id = 'crew-pulse'
pulse.setAttribute('aria-label', crewText.label)
$('cards').before(pulse)
let lastPulse = ''
function renderPulse() {
  const summary = crewPulse(state.agents, state.pending?.agentId)
  const signature = JSON.stringify(summary)
  if (signature === lastPulse) return
  lastPulse = signature
  const attention = button(
    summary.attention.length ? crewText.attention(summary.attention.length) : crewText.clear,
    () => {
      const index = summary.attention.findIndex((item) => item.id === selected)
      const next = summary.attention[(index + 1) % summary.attention.length]
      if (!next) return
      showView('mission')
      choose(next.id)
      if (next.reason === 'decision') $('approval').querySelector('button')?.focus()
      else $('cards').querySelector('[aria-selected="true"]')?.focus()
    },
    summary.attention.length ? 'subtle attention-button' : 'subtle',
  )
  attention.disabled = !summary.attention.length
  pulse.replaceChildren(
    node('span', crewText.working(summary.working), 'pulse-working'),
    node('span', crewText.queued(summary.queued), 'quiet'),
    attention,
  )
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
  const { groups, total } = selectFeed(state.lines, {
    agent: all ? undefined : selected,
    query: feedQuery,
    filter: feedFilter,
    reasoning,
  })
  const signature = JSON.stringify([selected, view, groups, total, feedQuery, feedFilter])
  if (lastFeed === signature) return
  const feed = $('feed'),
    atBottom = resetFeedPosition || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90,
    previous = feed.scrollTop
  // Keep the visible window intact when older results roll out of the runtime window.
  if (!atBottom) {
    $('feed-latest').textContent = feedText.updates
    return
  }
  lastFeed = signature
  $('feed-latest').textContent = feedText.latest
  const fragment = document.createDocumentFragment()
  $('feed-count').textContent = feedText.results(groups.length, total)
  $('feed-clear').hidden = !feedQuery && feedFilter === 'all'
  if (!groups.length) {
    const filtered = feedQuery.trim() || feedFilter !== 'all'
    const empty = node('div', undefined, 'empty')
    empty.append(
      node(
        'strong',
        filtered
          ? feedText.noMatches
          : state.ready
            ? 'A blank canvas. A capable crew.'
            : 'Your session will appear here.',
      ),
      node(
        'p',
        filtered
          ? feedText.tryAgain
          : state.ready
            ? 'Give an agent a direction below to begin.'
            : 'Open a project in the terminal. This page reconnects automatically.',
      ),
    )
    fragment.append(empty)
  }
  for (const group of groups) {
    const l = group[0]

    if (l.kind === 'diff') {
      const rows = group.map((line) => line.text)
      const who = l.agentId
      const el = node('article', undefined, 'entry diff')
      el.append(avatar(who))
      const content = node('div')
      const head = node('div', undefined, 'entry-head')
      head.append(node('b', who), node('span', 'changed'))
      const body = node('div', undefined, 'entry-content diff-body')
      for (const row of rows) body.append(node('div', row, `diff-row ${diffClass(row)}`))
      content.append(head, body)
      el.append(content)
      fragment.append(el)
      continue
    }

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
  resetFeedPosition = false
  updateFollow()
}

function updateFollow() {
  const feed = $('feed')
  const live = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90
  $('feed-latest').hidden = live
  $('feed-follow').textContent = live ? feedText.live : feedText.paused
}
function filterFeed() {
  feedQuery = $('feed-search').value
  feedFilter = $('feed-filter').value
  resetFeedPosition = true
  lastFeed = ''
  render()
}
const feedTools = node('div', undefined, 'feed-tools')
feedTools.id = 'feed-tools'
const search = node('input')
search.id = 'feed-search'
search.type = 'search'
search.placeholder = feedText.search
search.setAttribute('aria-label', feedText.searchLabel)
search.setAttribute('aria-describedby', 'feed-scope')
search.maxLength = 500
search.oninput = filterFeed
const filter = node('select')
filter.id = 'feed-filter'
filter.setAttribute('aria-label', feedText.filterLabel)
for (const [value, label] of Object.entries(feedText.filters)) {
  const option = node('option', label)
  option.value = value
  filter.append(option)
}
filter.onchange = filterFeed
const clear = button(feedText.clear, () => {
  search.value = ''
  filter.value = 'all'
  filterFeed()
  search.focus()
})
clear.id = 'feed-clear'
clear.hidden = true
const count = node('span', '', 'quiet small')
count.id = 'feed-count'
count.title = feedText.scope
count.setAttribute('role', 'status')
feedTools.append(search, filter, clear, count)
$('feed').before(feedTools)
const scope = node('small', feedText.scope, 'quiet feed-scope')
scope.id = 'feed-scope'
$('feed').before(scope)
const follow = node('div', undefined, 'feed-follow')
follow.id = 'feed-navigation'
const followStatus = node('span', feedText.live, 'quiet small')
followStatus.id = 'feed-follow'
const latest = button(feedText.latest, () => {
  resetFeedPosition = true
  lastFeed = ''
  render()
  $('feed').scrollTop = $('feed').scrollHeight
  updateFollow()
  $('feed').focus()
})
latest.id = 'feed-latest'
latest.hidden = true
follow.append(followStatus, latest)
$('feed').after(follow)
$('feed').addEventListener('scroll', updateFollow, { passive: true })

const nativePane = node('section', undefined, 'native-pane')
nativePane.id = 'native-pane'
nativePane.hidden = true
nativePane.addEventListener('keydown', (event) => event.stopPropagation())
const nativeControls = node('div', undefined, 'native-controls')
const nativeBody = node('div', undefined, 'native-body')
nativePane.append(nativeControls, node('p', nativeText.context, 'quiet small'), nativeBody)
$('details').after(nativePane)
const nativeTerminal = initNativeTerminal({
  container: nativeBody, token: () => token, session: () => state?.sessionId,
  agent: () => selected, onError: toast,
})
nativeControls.append(
  button(nativeText.reconnect, () => nativeTerminal.open()),
  button(nativeText.stop, () => nativeTerminal.stop()),
  button(nativeText.detach, () => { nativeTerminal.close(); tab = 'conversation'; render() }),
)
const nativeTab = button(nativeText.tab, () => {
  tab = 'native'
  render()
  nativeTerminal.open()
}, 'tab')
nativeTab.id = 'native-tab'
nativeTab.hidden = true
document.querySelector('.tabs').append(nativeTab)

const commandTrigger = button(commandText.trigger, () => {}, 'subtle')
commandTrigger.id = 'commands'
commandTrigger.append(node('kbd', '⌘ K'))
document.querySelector('.top-actions').prepend(commandTrigger)
const commandPalette = initPalette({
  trigger: commandTrigger,
  getActions: () => [
    ...Object.entries(commandText.views).map(([id, label]) => ({
      id: `view:${id}`, label, run: () => showView(id),
    })),
    ...(state?.agents || []).map((agent) => ({
      id: `agent:${agent.id}`,
      label: commandText.agent(agent.id),
      description: `${agent.model} · ${agent.status}`,
      keywords: [agent.role, agent.provider || ''],
      run: () => { showView('mission'); choose(agent.id) },
    })),
    { id: 'compose', label: commandText.compose, run: () => { showView('mission'); $('message').focus() } },
    { id: 'search', label: commandText.search, run: () => {
      if (view === 'mission' && !$('feed-tools').hidden) search.focus()
      else {
        showView('overview')
        activitySurface.scrollIntoView({ block: 'start' })
        activitySurface.querySelector('input')?.focus()
      }
    } },
    { id: 'latest', label: commandText.latest, run: () => {
      if (view === 'mission' && !$('feed').hidden) latest.click()
      else {
        showView('overview')
        activitySurface.scrollIntoView({ block: 'start' })
        activitySurface.querySelector('.activity-log-stats button')?.click()
      }
    } },
    { id: 'help', label: commandText.help, run: help },
  ],
})
let pendingId = ''
function renderApproval() {
  const p = state.pending
  $('approval').hidden = !p || view !== 'mission'
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
const settingsView = initSettings({ node, button, avatar, dialog, field, act, perform, inspect, editModel, editDefinition, toast })
const memoryView = initMemoryGraph({ toggle: (on) => perform({ type: 'memory', on }, () => inspect()) })
function renderDetails() {
  if (!['tasks', 'memory', 'settings'].includes(view)) return
  const signature = JSON.stringify([
    view,
    inspected,
    state.memory,
    state.sharedMemory,
    state.agents.map((a) => [a.id, a.model, a.yolo, a.task, a.status, a.provider, a.cost, a.estimated, a.queued, a.permissionOwner]),
    state.plugins,
    state.themes,
    state.cwd,
  ])
  if (signature === detailsSignature) return
  detailsSignature = signature
  const el = $('details')
  if (view === 'memory') {
    memoryView.render(el, state.memory || inspected?.memory || {}, state.sharedMemory)
    return
  }
  if (view === 'settings') {
    settingsView.render(el, state, inspected)
    return
  }
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
    el.append(node('p', taskText.activityHelp, 'quiet small'))
    for (const task of taskCards(inspected?.tasks || [], state.agents)) {
      const row = node('article', undefined, 'task-card')
      const title = node('div', undefined, 'task-card-title')
      title.append(node('h3', task.name), node('span', taskText.activity[task.activity], 'quiet'))
      row.append(title, node('p', task.main ? taskText.repository : taskText.worktree, 'quiet small'))
      const evidence = node('div', undefined, 'task-evidence')
      evidence.append(
        node('span', task.changed ? taskText.changed(task.changed) : taskText.clean),
        node('span', task.behind ? taskText.behind(task.behind) : taskText.current),
      )
      const metadata = node('dl')
      metadata.append(
        node('dt', taskText.checkout), node('dd', task.path),
        node('dt', taskText.commit), node('dd', task.head || taskText.unknownCommit),
        node('dt', taskText.cost), node('dd', money(task.knownCost)),
      )
      row.append(evidence, metadata)
      if (task.main) row.append(node('p', taskText.mainChanges, 'quiet small'))
      if (task.partialCost) row.append(node('p', taskText.partialCost, 'quiet small'))
      if (task.estimatedCost) row.append(node('p', taskText.estimatedCost, 'quiet small'))
      const agents = node('div', undefined, 'task-agents')
      agents.setAttribute('aria-label', taskText.agents)
      for (const agent of task.agents) {
        const link = button(`${agent.id} · ${agent.status} · ${agent.model}`, () => {
          showView('mission')
          choose(agent.id)
        })
        link.setAttribute('aria-label', taskText.openAgent(agent.id))
        link.setAttribute('aria-description', `${agent.status} · ${agent.model}`)
        agents.append(link)
      }
      row.append(agents)
      el.append(row)
    }
    if (!inspected?.tasks?.length) el.append(node('p', taskText.empty))
  }

}
function render() {
  if (!state) return
  quickChat.render(state, connected)
  if (!state.agents.some((a) => a.id === selected)) {
    if (tab === 'native') {
      nativeTerminal.close()
      tab = 'conversation'
    }
    drafts.set(selected, $('message').value)
    selected = quickChat.contact() || state.target || state.agents[0]?.id || ''
    $('message').value = drafts.get(selected) || ''
  }
  $('project').textContent = state.cwd.split('/').filter(Boolean).pop() || 'Workspace'
  $('breadcrumb-project').textContent = $('project').textContent
  $('path').textContent = state.cwd
  $('cost').textContent = money(state.total)
  $('cost-note').textContent = state.agents.some((a) => a.provider === 'claude-code')
    ? nativeText.unreportedUsage
    : state.agents.some((a) => a.estimated)
    ? 'Includes list-price estimates'
    : 'Reported usage'
  $('recipient').textContent = selected || 'your crew'
  $('message').placeholder = workspaceText.placeholder(selected || 'your crew')
  $('send').textContent = workspaceText.message(selected || 'your crew')
  const agent = state.agents.find((a) => a.id === selected)
  if (tab === 'native' && agent?.provider !== 'claude-code') {
    nativeTerminal.close()
    tab = 'conversation'
  }
  $('queue-label').textContent = agent?.queued ? `${agent.queued} waiting` : ''
  $('footer-status').textContent = workspaceText.footer(state.agents.length, state.sharedMemory)
  $('live').textContent = connected
    ? state.ready
      ? 'LIVE SESSION'
      : 'WAITING FOR SESSION'
    : 'DISCONNECTED'
  $('send').disabled = sending || !connected || !state.ready
  $('stop').disabled = !connected || !agent
  const names = workspaceText.views
  document.querySelector('main').dataset.view = view
  $('view-label').textContent = names[view]
  $('heading').textContent = names[view]
  $('subheading').textContent = workspaceText.descriptions[view]
  $('thinking').setAttribute('aria-pressed', String(reasoning))
  $('conversation-tab').classList.toggle('active', tab === 'conversation')
  $('diff-tab').classList.toggle('active', tab === 'diff')
  nativeTab.hidden = agent?.provider !== 'claude-code'
  nativeTab.classList.toggle('active', tab === 'native')
  nativePane.hidden = tab !== 'native'
  document.querySelector('.panel-actions').hidden = tab === 'native'
  const detail = ['tasks', 'memory', 'settings'].includes(view) || tab === 'diff' || tab === 'native'
  $('feed').hidden = detail
  $('feed-tools').hidden = detail
  $('feed-scope').hidden = detail
  $('feed-navigation').hidden = detail
  $('details').hidden = !detail || tab === 'native'
  const teamMode = ['graph', 'grid'].includes(view)
  const overviewMode = view === 'overview'
  overviewWorkspace.hidden = !overviewMode
  $('overview-surface').hidden = !overviewMode
  $('workspace').hidden = teamMode || overviewMode
  $('cards').hidden = view !== 'mission'
  $('composer').hidden = view !== 'mission'
  document.querySelector('.panel-toolbar').hidden = view !== 'mission'
  $('approval').hidden = view !== 'mission' || !state.pending
  pulse.hidden = overviewMode
  teamViews.render(state, view === 'graph' ? 'graph' : 'mission', selected)
  tiling.render(state, view === 'grid', selected)
  activityView.render(state, overviewMode)
  if (overviewMode) overview.render(state)
  renderRoster()
  renderPulse()
  renderApproval()
  if (overviewMode) return
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
      nativeTerminal.close()
      if (tab === 'native') tab = 'conversation'
      commandPalette.close()
      $('modal').close()
      modalSubmit = undefined
      drafts.clear()
      selected = ''
      $('message').value = ''
      inspected = undefined
      lastFeed = ''
      lastRoster = ''
      feedQuery = ''
      feedFilter = 'all'
      search.value = ''
      filter.value = 'all'
      resetFeedPosition = true
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
    if (state) quickChat.render(state, false)
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

// Workspace details are optional; keep the conversation visible by default.
$('sidebar-toggle').onclick = () => {
  const open = $('sidebar').hidden
  $('sidebar').hidden = !open
  $('sidebar-toggle').setAttribute('aria-expanded', String(open))
  $('sidebar-toggle').setAttribute('aria-label', `${open ? 'Close' : 'Open'} workspace sidebar`)
  document.querySelector('.shell').classList.toggle('sidebar-open', open)
}
$('cards').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const agents = state?.agents || []
  if (!agents.length) return
  event.preventDefault()
  const current = agents.findIndex((agent) => agent.id === selected)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? agents.length - 1
    : (current + (event.key === 'ArrowRight' ? 1 : agents.length - 1)) % agents.length
  choose(agents[index].id)
  $('cards').querySelector('[aria-selected="true"]')?.focus()
})

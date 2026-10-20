import { defaultChatAgent, chatMessages } from './quick-chat.js'
import { quickChatText as text } from './quick-chat-text.js'

const el = (tag, content, className) => {
  const node = document.createElement(tag)
  if (content !== undefined) node.textContent = content
  if (className) node.className = className
  return node
}
export function initQuickChat({ host, launcherHost, send, choose }) {
  let state, cwd, contact = '', connected = false, shown = false, signature = '', previousFocus
  const drafts = new Map(), pending = new Set()
  const requestKey = id => JSON.stringify([state?.sessionId, id])
  const launcher = el('button', text.launch(''), 'quick-chat-launcher subtle')
  launcher.type = 'button'
  launcher.setAttribute('aria-controls', 'quick-chat')
  launcher.setAttribute('aria-expanded', 'false')
  launcherHost.prepend(launcher)
  host.id = 'quick-chat'
  host.className = 'quick-chat'
  host.hidden = true
  host.setAttribute('role', 'dialog')
  host.setAttribute('aria-modal', 'false')
  host.setAttribute('aria-labelledby', 'quick-chat-title')
  const header = el('header', undefined, 'quick-chat-header')
  const heading = el('h2', text.title)
  heading.id = 'quick-chat-title'
  const close = el('button', '×', 'subtle')
  close.type = 'button'; close.setAttribute('aria-label', text.close)
  header.append(heading, close)
  const label = el('label', text.contact, 'quick-chat-contact')
  const select = el('select')
  select.setAttribute('aria-label', text.contact)
  label.append(select)
  const scope = el('small', text.scope, 'quick-chat-scope')
  const status = el('p', '', 'quick-chat-status')
  const feed = el('div', undefined, 'quick-chat-feed')
  feed.tabIndex = 0
  feed.setAttribute('aria-label', text.title)
  const full = el('button', text.full, 'subtle quick-chat-full')
  full.type = 'button'
  const form = el('form', undefined, 'quick-chat-form')
  const input = el('textarea')
  input.rows = 3
  const submit = el('button', text.send, 'primary')
  submit.type = 'submit'
  const error = el('p', '', 'quick-chat-error')
  error.setAttribute('role', 'status')
  form.append(input, submit)
  host.append(header, label, scope, status, feed, el('small', text.history, 'quick-chat-scope'), full, error, form)
  function dismiss() {
    shown = false; host.hidden = true; launcher.setAttribute('aria-expanded', 'false')
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }
  function open() {
    previousFocus = document.activeElement; shown = true; host.hidden = false
    launcher.setAttribute('aria-expanded', 'true')
    signature = ''; paint()
    input.focus()
  }
  launcher.onclick = () => shown ? dismiss() : open()
  close.onclick = dismiss
  full.onclick = () => { const id = contact; dismiss(); if (id) choose(id) }
  host.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); dismiss() }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault(); event.stopPropagation(); form.requestSubmit()
    }
  })
  input.oninput = () => drafts.set(contact, input.value)
  select.onchange = () => {
    drafts.set(contact, input.value)
    contact = defaultChatAgent(state.agents, select.value, state.target)
    input.value = drafts.get(contact) || ''
    error.textContent = ''
    try { localStorage.setItem(`aidcrew:contact:v1:${cwd}`, contact) }
    catch { error.textContent = text.storage }
    signature = ''; paint()
  }
  form.onsubmit = async event => {
    event.preventDefault()
    const message = input.value.trim(), target = contact, session = state?.sessionId, key = requestKey(contact)
    if (!message || !target || !connected || !state?.ready || pending.has(key)) return
    pending.add(key); error.textContent = ''; paint()
    try {
      await send(target, message)
      if (session === state?.sessionId && drafts.get(target)?.trim() === message) {
        drafts.delete(target)
        if (contact === target) input.value = ''
      }
    } catch (failure) {
      if (session === state?.sessionId) error.textContent = failure instanceof Error ? failure.message : text.failure
    } finally { pending.delete(key); paint() }
  }
  function paint() {
    launcher.textContent = text.launch(contact)
    launcher.disabled = !contact
    const agent = state?.agents.find(agent => agent.id === contact)
    submit.disabled = !agent || !connected || !state?.ready || pending.has(requestKey(contact))
    submit.textContent = pending.has(requestKey(contact)) ? text.sending : text.send
    input.placeholder = text.placeholder(contact)
    input.setAttribute('aria-label', text.placeholder(contact))
    const agentStatus = agent?.status === 'working' ? text.working : agent?.status === 'idle' ? text.ready : agent?.status === 'stopped' ? text.stopped : agent?.status || ''
    status.textContent = !connected ? text.disconnected : !agent ? text.unavailable : `${agentStatus} · ${text.queue(agent.queued || 0)}`
    if (!shown) return
    const messages = chatMessages(state?.lines || [], contact)
    const next = JSON.stringify([contact, messages])
    if (next === signature) return
    const follow = !signature || feed.scrollHeight - feed.clientHeight - feed.scrollTop < 40
    const scroll = feed.scrollTop
    signature = next
    feed.replaceChildren()
    if (!messages.length) feed.append(el('p', text.empty, 'quiet'))
    for (const message of messages) {
      const item = el('article', undefined, `quick-chat-message ${message.kind}`)
      item.append(el('small', message.kind === 'ask' ? text.you : contact), el('p', message.text))
      feed.append(item)
    }
    feed.scrollTop = follow ? feed.scrollHeight : scroll
  }
  return {
    open,
    contact: () => contact,
    render(next, online) {
      const changed = cwd !== next.cwd || state?.sessionId !== next.sessionId
      state = next; connected = online
      if (changed) {
        cwd = state.cwd; drafts.clear(); input.value = ''; error.textContent = ''; signature = ''
        let saved
        try { saved = localStorage.getItem(`aidcrew:contact:v1:${cwd}`) }
        catch { error.textContent = text.storage }
        contact = defaultChatAgent(state.agents, saved, state.target)
      } else {
        const valid = defaultChatAgent(state.agents, contact, state.target)
        if (valid !== contact) { contact = valid; input.value = drafts.get(contact) || ''; signature = '' }
      }
      const ids = state.agents.map(agent => agent.id)
      if (JSON.stringify([...select.options].map(option => option.value)) !== JSON.stringify(ids)) {
        select.replaceChildren(...ids.map(id => { const option = el('option', id); option.value = id; return option }))
      }
      select.value = contact
      paint()
    },
  }
}

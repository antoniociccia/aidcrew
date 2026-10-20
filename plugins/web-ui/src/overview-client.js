import { overview } from './overview.js'
import { overviewText as text } from './overview-text.js'

const node = (tag, content, className) => {
  const result = document.createElement(tag)
  if (content !== undefined) result.textContent = content
  if (className) result.className = className
  return result
}
const action = (label, key, callback, className = 'overview-button') => {
  const button = node('button', label, className)
  button.type = 'button'
  button.dataset.overviewAction = key
  button.onclick = callback
  return button
}

/** A read-only overview of the existing session; actions open existing conversations. */
export function initOverview({ host, avatar, choose, showView }) {
  let signature = ''
  let session = ''
  let requestExpanded = false
  let updateExpanded = false
  let teamExpanded = false
  host.classList.add('overview-surface')

  function crewRow(agent) {
    const row = node('article', undefined, `overview-agent ${agent.group}`)
    const identity = node('div', undefined, 'overview-agent-identity')
    const name = node('div')
    name.append(node('h3', agent.id), node('p', agent.role || agent.id, 'overview-role'))
    identity.append(avatar(agent.id), name)
    const statusKey = agent.group === 'approval' ? 'pending' : agent.status
    identity.append(node('span', text.status[statusKey] || agent.status, 'overview-status'))
    row.append(identity)
    const work = node('div', undefined, 'overview-agent-work')
    const showInstruction = agent.group === 'working' && agent.assignment?.kind === 'ask'
    if (showInstruction) work.append(node('small', text.assignment), node('p', agent.assignment.text, 'overview-assignment'))
    const footer = node('div', undefined, 'overview-agent-footer')
    if (agent.task && agent.task !== 'main') footer.append(node('span', `${text.task}: ${agent.task}`, 'overview-task'))
    if (agent.queued) footer.append(node('span', text.queuedAgent(agent.queued), 'overview-queue'))
    const open = action(text.open, `agent:${agent.id}`, () => choose(agent.id), 'overview-link')
    open.setAttribute('aria-label', text.openAgent(agent.id))
    footer.append(open)
    work.append(footer)
    row.append(work)
    return row
  }

  function attentionSection(items) {
    const section = node('section', undefined, 'overview-attention')
    const heading = node('div', undefined, 'overview-section-heading')
    heading.append(node('h2', text.attention))
    if (items.length) heading.append(node('span', String(items.length), 'overview-attention-count'))
    section.append(heading)
    if (!items.length) {
      section.append(node('p', text.clear, 'overview-clear'))
      return section
    }
    section.append(node('p', text.attentionHelp, 'overview-help'))
    for (const item of items) {
      const card = node('article', undefined, `overview-attention-item ${item.kind}`)
      const title = node('div', undefined, 'overview-attention-title')
      title.append(node('strong', item.agentId), node('span', item.kind === 'approval' ? text.approval : text.stoppedError))
      card.append(title)
      card.append(node('p', item.kind === 'approval' ? item.pending.summary : item.error, 'overview-attention-detail'))
      card.append(action(item.kind === 'approval' ? text.reviewDecision : text.reviewError, `attention:${item.agentId}`, () => choose(item.agentId), 'overview-button secondary'))
      section.append(card)
    }
    return section
  }

  return {
    render(state) {
      const model = overview(state)
      const next = JSON.stringify([state.sessionId, model])
      if (signature === next) return
      if (session !== state.sessionId) {
        requestExpanded = false
        updateExpanded = false
        teamExpanded = false
        session = state.sessionId
      }
      signature = next
      const focusedAction = host.contains(document.activeElement) ? document.activeElement?.dataset.overviewAction : undefined
      const scroll = host.scrollTop
      const heading = node('header', undefined, 'overview-heading')
      heading.append(node('h1', text.title), node('p', text.subtitle))
      const stats = node('div', undefined, 'overview-summary')
      stats.append(node('span', text.working(model.counts.working), 'overview-working'), node('span', text.waiting(model.counts.idle)), node('span', text.queued(model.counts.queued)))
      heading.append(stats)
      if (!model.crew.length) {
        const empty = node('section', undefined, 'overview-empty')
        empty.append(node('h2', text.emptyTitle), node('p', text.emptyHelp))
        host.replaceChildren(heading, empty)
        return
      }
      const context = node('section', undefined, 'overview-context')
      const contextBody = node('div', undefined, 'overview-context-body')
      const label = model.leadUpdate ? text.leadUpdate : model.startingRequest ? text.requestScope : model.hasHistory ? text.continueTitle : text.context
      const contextText = model.leadUpdate?.text || model.startingRequest?.text || (model.hasHistory ? text.continueHelp : text.noRequest)
      contextBody.append(node('small', label), node('p', contextText, 'overview-request'))
      if (model.leadUpdate) {
        const full = node('details', undefined, 'overview-request-full overview-lead-update')
        full.open = updateExpanded
        full.ontoggle = () => { if (full.isConnected) updateExpanded = full.open }
        const summary = node('summary', text.fullUpdate)
        summary.dataset.overviewAction = 'lead-update'
        full.append(summary, node('p', model.leadUpdate.text))
        contextBody.append(full)
      }
      if (model.startingRequest) {
        const full = node('details', undefined, 'overview-request-full overview-original-request')
        full.open = requestExpanded
        full.ontoggle = () => { if (full.isConnected) requestExpanded = full.open }
        const summary = node('summary', model.leadUpdate ? text.originalRequest : text.fullRequest)
        summary.dataset.overviewAction = 'request'
        full.append(summary, node('p', model.startingRequest.text))
        contextBody.append(full)
      } else if (!model.hasHistory) contextBody.append(node('p', text.requestHelp, 'overview-help'))
      context.append(contextBody)
      if (model.lead) {
        const nextAction = node('div', undefined, 'overview-next-action')
        nextAction.append(action(text.leadAction, 'lead', () => choose(model.lead.id)), node('small', text.lead(model.lead.id)))
        context.append(nextAction)
      }
      const body = node('div', undefined, 'overview-body')
      const crew = node('details', undefined, 'overview-crew overview-team')
      crew.open = teamExpanded
      crew.ontoggle = () => { if (crew.isConnected) teamExpanded = crew.open }
      const crewHeading = node('summary', undefined, 'overview-section-heading')
      crewHeading.append(node('h2', text.crew), node('span', String(model.crew.length), 'overview-crew-count'))
      crew.append(crewHeading, node('p', text.crewHelp, 'overview-help'))
      for (const agent of [...model.groups.approval, ...model.groups.working, ...model.groups.stopped, ...model.groups.idle]) crew.append(crewRow(agent))
      const sidebar = node('aside', undefined, 'overview-sidebar')
      sidebar.append(attentionSection(model.attention))
      body.append(crew, sidebar)
      host.replaceChildren(heading, context, body)
      host.scrollTop = scroll
      if (focusedAction) [...host.querySelectorAll('[data-overview-action]')].find(control => control.dataset.overviewAction === focusedAction)?.focus({ preventScroll: true })
    },
  }
}

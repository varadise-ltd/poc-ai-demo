<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { cameraList, liveEvents, selectedScript, store } from '../store'
import { snapshotUrl } from '../api'
import type { EventItem } from '../types'

interface Action { id: string; label: string; primary?: boolean }
interface Msg {
  id: number
  role: 'ai' | 'user' | 'system'
  type?: string
  priority?: 'high' | 'medium' | 'low'
  title?: string
  html: string
  steps?: string[]
  map?: boolean
  image?: { src: string; caption: string }
  status?: { text: string; busy: boolean }
  report?: EventItem
  reportExtras?: { analysed: boolean; dispatched: boolean; confirmed: boolean }
  related?: string
  actions?: Action[]
  timestamp: string
}
type MsgInput = Omit<Msg, 'id' | 'timestamp' | 'role'> & { role?: Msg['role'] }

const open = ref(false)
const unread = ref(0)
const typing = ref(false)
const input = ref('')
const messages = ref<Msg[]>([])
const bodyEl = ref<HTMLElement | null>(null)
let msgId = 1

interface Incident { status: string; event: EventItem; analysed: boolean; dispatched: boolean; confirmed: boolean }
const incident = ref<Incident | null>(null)

const model = computed(() => selectedScript.value.name)
const camera = computed(() => store.selectedCamera)

const nowTime = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
const nowDate = () => new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function scrollChat() {
  nextTick(() => { if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight })
}
function push(msg: MsgInput) {
  messages.value.push({ role: 'ai', ...msg, id: msgId++, timestamp: nowTime() })
  if (!open.value && (msg.role ?? 'ai') === 'ai') unread.value++
  scrollChat()
}
async function say(msg: MsgInput, delay = 700) {
  typing.value = true
  scrollChat()
  await new Promise((r) => setTimeout(r, delay))
  typing.value = false
  push(msg)
}
function toggle(v: boolean) {
  open.value = v
  if (v) { unread.value = 0; scrollChat() }
}

function eventHtml(e: EventItem) {
  return `<strong>${esc(e.name.toLowerCase())}</strong> from <em>${esc(e.script)}</em> on <strong>${esc(e.camera)}</strong> at ${esc(e.time)} (around ${esc(e.confidence)} confidence)`
}
function alertMessage(e: EventItem): MsgInput {
  return {
    type: 'alert', priority: 'high',
    title: `Something needs a look — ${e.name}`,
    html:
      `<p>I just saw a ${eventHtml(e)}.</p>` +
      `<p>${esc(e.meta)}. I’ve marked it as <strong>Zone A</strong> on the map so we share the same picture.</p>` +
      '<p>How do you want to handle it — talk through a quick check, send R04 for a closer look, or something else?</p>',
    map: true,
    related: `${e.time} · ${e.camera} · ${e.script}`,
    actions: [
      { id: 'analyse', label: 'Walk me through it', primary: true },
      { id: 'dispatch', label: 'Send R04' },
      { id: 'confirm', label: 'Confirm & report' },
    ],
  }
}
function openIncident(e: EventItem) {
  incident.value = { status: 'Open', event: e, analysed: false, dispatched: false, confirmed: false }
}
function currentEvent(): EventItem | null {
  return incident.value?.event ?? liveEvents.value.find((e) => !e.ok) ?? liveEvents.value[0] ?? null
}
function analyseMessage(e: EventItem | null): MsgInput {
  if (incident.value) incident.value.analysed = true
  const lines = [
    'Check the live feed or latest snapshot — is the situation still active?',
    'If people are involved, a calm on-the-spot reminder is often enough before escalating.',
    'Note anything that could raise risk (fire, access, crowding, equipment).',
    'R04 is about 200 m from Zone A if you want remote eyes without walking over.',
  ]
  const m = (e?.script ?? model.value).toLowerCase()
  if (m.includes('smok')) {
    lines[1] = 'If someone is smoking, a calm reminder and redirect to the designated area is usually the first step.'
    lines[2] = 'Quick visual for butts or anything that could be a fire risk.'
  } else if (m.includes('helmet') || m.includes('ppe')) {
    lines[1] = 'If PPE is missing, confirm whether they’re still in the restricted zone and remind them of the rule.'
  } else if (m.includes('people') || m.includes('crowd')) {
    lines[1] = 'If it’s crowding, check exits and whether you need a temporary hold on entry.'
  }
  return {
    type: 'suggestion', priority: 'high', title: 'A practical way to handle this',
    html: '<p>Here’s a simple sequence I’d use on shift — adapt it if the floor looks different in person:</p>',
    steps: lines.map(esc), map: true,
    actions: [{ id: 'dispatch', label: 'Send R04', primary: true }, { id: 'confirm', label: 'Confirm & write report' }],
  }
}
function dispatchMessage(): MsgInput {
  if (incident.value) { incident.value.dispatched = true; incident.value.status = 'Robot Dispatched' }
  return {
    type: 'action', priority: 'medium', title: 'R04 heading to Zone A',
    html:
      '<p>Understood — I’ve tasked <strong>Robotic Dog R04</strong> toward Zone A.</p>' +
      '<p>The map shows the suggested route from R04’s stand. In a live deployment this would track as it moves.</p>' +
      '<p>When you’re happy with what you see, say the word and I’ll close this out with a short safety report.</p>',
    map: true,
    actions: [{ id: 'confirm', label: 'Confirm & write report', primary: true }],
  }
}
// R04 "arrives" 5s after dispatch and shares a frame from the camera named R04.
function r04FrameMessage(): MsgInput {
  const other = cameraList.value.find((c) => c.trim().toLowerCase() === 'r04')
    ?? store.cameras.find((c) => c.name.trim().toLowerCase() === 'r04')?.name
  if (!other) {
    return { type: 'info', priority: 'medium', title: 'R04 on site', html: '<p>R04 is in position, but no camera named “R04” is configured, so I can’t pull a frame from it.</p>' }
  }
  return {
    type: 'action', priority: 'medium', title: 'R04 view — latest camera frame',
    html: `<p>R04 is in position. Here’s a fresh frame from its camera, <strong>${esc(other)}</strong>:</p>`,
    image: { src: `${snapshotUrl(other, '', false)}&_=${Date.now()}`, caption: `${other} · ${nowTime()}` },
  }
}
function scheduleR04Frame() {
  // start after the dispatch reply has appeared so the status shows below it
  setTimeout(runR04Status, 950)
}
function runR04Status() {
  const stages = ['R04 acknowledged the dispatch…', 'R04 moving toward Zone A…', 'R04 moving toward Zone A…', 'R04 in position, aiming camera…', 'R04 capturing frame…']
  push({ role: 'system', type: 'info', html: '', status: { text: stages[0], busy: true } })
  const st = messages.value[messages.value.length - 1].status!
  let sec = 0
  const timer = setInterval(() => {
    sec++
    if (sec >= 5) {
      clearInterval(timer)
      st.text = 'R04 frame captured'
      st.busy = false
      say(r04FrameMessage(), 300)
    } else {
      st.text = `${stages[sec]} (${5 - sec}s)`
    }
  }, 1000)
}

function confirmMessage(): MsgInput {
  const e = currentEvent()
  if (!e) {
    return { type: 'suggestion', html: '<p>There’s no open incident to report yet. When a detection comes in, confirm it with me and I’ll draft a short safety report.</p>' }
  }
  if (incident.value) { incident.value.confirmed = true; incident.value.status = 'Resolved / Closed' }
  return {
    type: 'info', priority: 'low', title: 'Confirmed — draft safety report',
    html: '<p>Thanks for confirming. I’ve closed the incident and put together a simple safety report for the log. You can copy it into your formal system or tweak the wording first.</p>',
    report: e,
    reportExtras: {
      analysed: !!incident.value?.analysed,
      dispatched: !!incident.value?.dispatched,
      confirmed: true,
    },
    actions: [{ id: 'help', label: 'Anything else?' }],
  }
}
function reportHtml(e: EventItem, x: NonNullable<Msg['reportExtras']>) {
  const actions: string[] = []
  if (x.analysed) actions.push('Inspection guidance reviewed with operator')
  if (x.dispatched) actions.push('Robotic Dog R04 dispatched to Zone A')
  if (x.confirmed) actions.push('Human confirmation received — incident closed')
  if (!actions.length) actions.push('Alert acknowledged on live view')
  const rows: [string, string][] = [
    ['Date', nowDate()], ['Time', e.time || nowTime()],
    ['Site', 'HKCEC — Hong Kong Convention and Exhibition Centre'], ['Zone', 'Zone A'],
    ['Camera', e.camera], ['AI model', e.script], ['Detection', e.name], ['Detail', e.meta],
    ['Confidence', e.confidence], ['Status', incident.value?.status ?? 'Open'], ['Actions taken', actions.join('; ')],
  ]
  return '<div class="safety-report"><h4>Safety incident report (draft)</h4><table>' +
    rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('') +
    '</table><div class="report-note">Generated after operator confirmation. For internal safety log only — adjust wording before formal filing if needed.</div></div>'
}

function handleAction(id: string) {
  if (id === 'analyse') say(analyseMessage(currentEvent()), 850)
  else if (id === 'dispatch') { say(dispatchMessage(), 900); scheduleR04Frame() }
  else if (id === 'confirm') say(confirmMessage(), 900)
  else if (id === 'help') say({ type: 'info', html: '<p>I’m still here if another detection comes in, or if you want to talk through the map, R04, or a past alert.</p>' }, 500)
}

function respond(text: string) {
  const t = text.toLowerCase().trim()
  const evt = currentEvent()
  if (/^(hi|hello|hey|good morning|good afternoon)\b/.test(t)) {
    return say({ type: 'info', html: `<p>Hey — I’m here on the live view. Watching <strong>${esc(model.value)}</strong> on ${esc(camera.value)}. What do you need?</p>` }, 600)
  }
  if (/report|write up|log this|document|confirm|close|resolve|all good/.test(t)) return say(confirmMessage(), 850)
  if (/analyse|suggest|what should|walk me|check|inspect|how do|next step/.test(t)) return say(analyseMessage(evt), 800)
  if (/dispatch|send (the )?dog|send r04|robot|r04/.test(t)) { scheduleR04Frame(); return say(dispatchMessage(), 850) }
  if (/map|where|location|layout|direction|hkcec|zone/.test(t)) {
    return say({ type: 'suggestion', title: 'Zone A on the site map', html: '<p>Here’s a simple layout for <strong>HKCEC</strong>. <strong>Zone A</strong> is the flagged area; the dashed line is R04’s route toward it.</p>', map: true }, 700)
  }
  if (/alert|detection|what happened|status|current/.test(t)) {
    if (evt) return say(alertMessage(evt), 700)
    return say({ type: 'suggestion', html: '<p>Nothing open right now on this stream. I’ll message you as soon as a detection fires.</p>' }, 650)
  }
  if (/help|what can you|how do you/.test(t)) {
    return say({ type: 'info', html: '<p>I sit with you on this live view for any AI detection. When something fires I’ll explain it, show Zone A on the map, and we can talk through a check, send R04, or confirm and I’ll draft a safety report.</p>' }, 750)
  }
  return say({ type: 'text', html: '<p>Are you asking about the current alert, the map, sending R04, closing the incident, or a safety report? Tell me in your own words and I’ll adapt.</p>' }, 550)
}

function send() {
  const text = input.value.trim()
  if (!text) return
  push({ role: 'user', type: 'text', html: esc(text) })
  input.value = ''
  respond(text)
}
function clearChat() {
  messages.value = []
  push({ role: 'system', type: 'info', html: 'Chat cleared.' })
}

// Real detections drive the assistant: a new non-OK live event raises an alert.
const seen = new Set<string>()
let primed = false
function eventKey(e: EventItem) { return e.eventId ?? `${e.timestamp ?? e.time}|${e.camera}|${e.name}` }
watch(liveEvents, (list) => {
  const fresh = list.filter((e) => !seen.has(eventKey(e)))
  list.forEach((e) => seen.add(eventKey(e)))
  if (!primed) { primed = true; return }          // don't replay history on first load
  const violation = fresh.find((e) => !e.ok)
  if (!violation) return
  openIncident(violation)
  open.value = true
  unread.value = 0
  say(alertMessage(violation), 900)
}, { immediate: true })

// Reset context when the operator switches camera / model.
watch([camera, model], () => { seen.clear(); primed = false; incident.value = null })

say({
  type: 'info',
  html:
    '<p>Hi — I’m your AI Safety Assistant on this live view. I work with <strong>whatever detection model</strong> you’ve selected.</p>' +
    '<p>When something flags, I’ll explain it in plain language, show where it is on the map, and we can decide the next step together.</p>',
}, 400)
</script>

<template>
  <div class="ai-chatbot" :class="{ open }">
    <button class="ai-chat-toggle" title="AI Safety Assistant" @click="toggle(!open)">
      <span>{{ open ? '×' : 'AI' }}</span>
      <span v-if="unread" class="ai-badge">{{ unread > 9 ? '9+' : unread }}</span>
    </button>
    <div class="ai-chat-panel">
      <div class="ai-chat-header">
        <div>
          <strong>AI Safety Assistant</strong>
          <div class="ai-chat-sub">Here to help with live site alerts</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="ai-icon-btn" @click="clearChat">Clear</button>
          <button class="ai-icon-btn" @click="toggle(false)">×</button>
        </div>
      </div>
      <div ref="bodyEl" class="ai-chat-body">
        <div v-for="m in messages" :key="m.id" class="ai-msg" :class="[m.role, m.type]">
          <div class="ai-msg-meta">
            <span class="ai-msg-role">{{ m.role === 'ai' ? 'Assistant' : m.role === 'user' ? 'You' : 'System' }}</span>
            <span>{{ m.timestamp }}</span>
          </div>
          <div v-if="m.title" class="ai-msg-title">
            <span v-if="m.priority" class="ai-priority" :class="m.priority">{{ m.priority }}</span>{{ m.title }}
          </div>
          <div class="ai-msg-body" v-html="m.html"></div>
          <div v-if="m.map" class="site-map">
            <div class="site-map-label">HKCEC · Hong Kong Convention &amp; Exhibition Centre</div>
            <div class="map-canvas">
              <div class="map-label-hall">Hall / Expo floor</div>
              <div class="map-label-harbour">Harbour side</div>
              <div class="map-dog" title="Robotic Dog R04">R04</div>
              <div class="map-path" title="Suggested path to Zone A"></div>
              <div class="map-zone a">Zone A</div>
            </div>
            <div class="map-legend">
              <span><i class="map-swatch dog"></i> R04 stand</span>
              <span><i class="map-swatch path"></i> Route to Zone A</span>
              <span><i class="map-swatch zone"></i> Alert zone</span>
            </div>
            <a class="map-gmaps" href="https://www.google.com/maps/place/Hong+Kong+Convention+and+Exhibition+Centre" target="_blank" rel="noopener">Open in Google Maps ↗</a>
          </div>
          <div v-if="m.status" class="ai-msg-status" :class="{ busy: m.status.busy }">
            <i class="ai-status-dot"></i>{{ m.status.text }}
          </div>
          <figure v-if="m.image" class="ai-msg-image">
            <img :src="m.image.src" :alt="m.image.caption" @load="scrollChat" />
            <figcaption>{{ m.image.caption }}</figcaption>
          </figure>
          <div v-if="m.report && m.reportExtras" v-html="reportHtml(m.report, m.reportExtras)"></div>
          <ol v-if="m.steps?.length" class="ai-msg-steps"><li v-for="(s, i) in m.steps" :key="i" v-html="s"></li></ol>
          <div v-if="m.related" class="ai-msg-event">{{ m.related }}</div>
          <div v-if="m.actions?.length" class="ai-msg-actions">
            <button v-for="a in m.actions" :key="a.id" class="btn" :class="{ primary: a.primary }" @click="handleAction(a.id)">{{ a.label }}</button>
          </div>
        </div>
        <div v-if="typing" class="typing"><span>·</span><span>·</span><span>·</span></div>
      </div>
      <div class="ai-chat-footer">
        <input v-model="input" type="text" placeholder="Ask me anything about this alert…" @keydown.enter="send" />
        <button class="btn primary" @click="send">Send</button>
      </div>
    </div>
  </div>
</template>

<style>
.ai-chatbot { position: fixed; right: 22px; bottom: 22px; z-index: 2000; font-family: inherit; }
.ai-chat-toggle {
  width: 56px; height: 56px; border-radius: 50%; border: none; background: var(--orange); color: #fff;
  font-weight: 800; font-size: 15px; letter-spacing: 0.4px;
  box-shadow: 0 8px 28px rgba(244, 123, 32, 0.45);
  display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;
  transition: transform 0.15s ease;
}
.ai-chat-toggle:hover { transform: scale(1.06); }
.ai-badge {
  position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 10px; background: var(--red); color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.ai-chat-panel {
  position: absolute; right: 0; bottom: 68px;
  width: min(460px, calc(100vw - 24px)); height: min(640px, calc(100vh - 88px));
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 16px 48px rgba(13, 37, 56, 0.18);
  display: none; flex-direction: column; overflow: hidden;
}
.ai-chatbot.open .ai-chat-panel { display: flex; }
.ai-chat-header {
  padding: 13px 14px; background: var(--navy); color: #fff;
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
}
.ai-chat-header strong { font-size: 13px; }
.ai-chat-sub { font-size: 11px; opacity: 0.7; margin-top: 2px; }
.ai-icon-btn {
  border: 1px solid rgba(255,255,255,0.25); background: transparent; color: #fff;
  border-radius: 6px; padding: 4px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.ai-chat-body {
  flex: 1; overflow-y: auto; padding: 12px; background: #f8fafb;
  display: flex; flex-direction: column; gap: 10px;
}
.ai-msg {
  max-width: 96%; padding: 11px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.5;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}
.ai-msg.ai { align-self: flex-start; background: #fff; border: 1px solid var(--line); }
.ai-msg.user { align-self: flex-end; background: var(--orange-soft); border: 1px solid #f5d0b0; }
.ai-msg.system { align-self: center; background: #eef2f5; color: var(--muted); font-size: 12px; max-width: 100%; text-align: center; }
.ai-msg.alert { border-left: 3px solid var(--red); }
.ai-msg.action { border-left: 3px solid var(--orange); }
.ai-msg.suggestion { border-left: 3px solid var(--green); }
.ai-msg-meta { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 11px; color: var(--muted); }
.ai-msg-role { font-weight: 650; letter-spacing: 0.2px; }
.ai-msg-title { font-weight: 700; font-size: 13.5px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ai-priority {
  font-size: 10px; font-weight: 750; text-transform: uppercase; letter-spacing: 0.4px;
  padding: 2px 6px; border-radius: 4px; color: #fff;
}
.ai-priority.high { background: var(--red); }
.ai-priority.medium { background: var(--yellow); }
.ai-priority.low { background: var(--muted); }
.ai-msg p { margin-bottom: 8px; }
.ai-msg p:last-child { margin-bottom: 0; }
.ai-msg-status { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.ai-status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green, #2e9e5b); display: inline-block; }
.ai-msg-status.busy .ai-status-dot { background: var(--orange); animation: blink 1s infinite; }
.ai-msg-image { margin: 8px 0 0; }
.ai-msg-image img { width: 100%; border-radius: 8px; display: block; background: #000; }
.ai-msg-image figcaption { font-size: 11px; opacity: 0.7; margin-top: 4px; }
.ai-msg-steps { margin: 8px 0 4px; padding-left: 18px; }
.ai-msg-steps li { margin-bottom: 4px; }
.ai-msg-event { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--line); font-size: 11px; color: var(--muted); }
.ai-msg-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
.ai-msg-actions .btn { font-size: 12px; padding: 7px 11px; }

.site-map {
  margin-top: 10px; background: #f0f4f8; border: 1px solid var(--line); border-radius: 10px;
  padding: 10px; position: relative; overflow: hidden;
}
.site-map-label {
  font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.4px; margin-bottom: 8px;
}
.map-canvas {
  position: relative; width: 100%; height: 168px; background:
    linear-gradient(#e8eef4 1px, transparent 1px) 0 0 / 24px 24px,
    linear-gradient(90deg, #e8eef4 1px, transparent 1px) 0 0 / 24px 24px,
    #f7fafc;
  border-radius: 8px; border: 1px solid #dce3ea;
}
.map-zone {
  position: absolute; border: 2px solid var(--red); background: rgba(217, 77, 77, 0.12);
  border-radius: 6px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 750; color: var(--red);
}
.map-zone.a { left: 58%; top: 28%; width: 32%; height: 36%; }
.map-dog {
  position: absolute; left: 12%; top: 62%; width: 28px; height: 28px;
  background: var(--navy); color: #fff; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 9px; font-weight: 800; box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  z-index: 2;
  animation: dogMove 1.8s ease-in-out 0.2s forwards;
}
.map-path {
  position: absolute; left: 18%; top: 48%; width: 0%; height: 2px;
  background: repeating-linear-gradient(90deg, var(--orange) 0 6px, transparent 6px 10px);
  transform: rotate(-18deg); transform-origin: left center; z-index: 1;
  animation: pathGrow 1.6s ease-out forwards;
}
.map-path::after {
  content: "▶"; position: absolute; right: -10px; top: -9px; color: var(--orange); font-size: 12px;
  opacity: 0; animation: fadeIn 0.3s ease 1.4s forwards;
}
.map-legend {
  display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 11px; color: var(--muted);
}
.map-legend span { display: inline-flex; align-items: center; gap: 4px; }
.map-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
.map-swatch.zone { background: rgba(217,77,77,0.35); border: 1px solid var(--red); }
.map-swatch.dog { background: var(--navy); border-radius: 50%; }
.map-swatch.path { background: var(--orange); height: 3px; width: 14px; border-radius: 1px; }
.map-label-hall {
  position: absolute; left: 8px; top: 8px; font-size: 10px; font-weight: 650;
  color: #8a9aab; letter-spacing: 0.3px;
}
.map-label-harbour {
  position: absolute; right: 8px; bottom: 8px; font-size: 10px; font-weight: 650;
  color: #8a9aab; letter-spacing: 0.3px;
}
.map-gmaps {
  display: inline-block; margin-top: 8px; font-size: 11px; font-weight: 650;
  color: var(--orange); text-decoration: none;
}
.map-gmaps:hover { text-decoration: underline; }
.safety-report {
  margin-top: 10px; background: #f7fafc; border: 1px solid var(--line);
  border-radius: 10px; padding: 12px 14px; font-size: 12.5px; line-height: 1.45;
}
.safety-report h4 {
  font-size: 13px; margin-bottom: 8px; color: var(--navy);
}
.safety-report table { width: 100%; border-collapse: collapse; margin: 6px 0 8px; }
.safety-report td { padding: 4px 0; vertical-align: top; }
.safety-report td:first-child { color: var(--muted); width: 38%; font-weight: 650; }
.safety-report .report-note {
  margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line);
  color: var(--muted); font-size: 11.5px;
}

.ai-chat-footer {
  padding: 10px; border-top: 1px solid var(--line); display: flex; gap: 8px; background: #fff;
}
.ai-chat-footer input {
  flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; font-size: 13px; outline: none;
}
.ai-chat-footer input:focus { border-color: var(--orange); }

.typing {
  align-self: flex-start; background: #fff; border: 1px solid var(--line);
  border-radius: 12px; padding: 10px 14px; font-size: 13px; color: var(--muted);
}
.typing span { animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: 0.2s; }
.typing span:nth-child(3) { animation-delay: 0.4s; }

.map-zone.a {
  animation: zonePulse 2s ease-in-out infinite;
}
@keyframes pathGrow {
  from { width: 0%; }
  to { width: 48%; }
}
@keyframes dogMove {
  0% { left: 12%; top: 62%; }
  100% { left: 52%; top: 38%; }
}
@keyframes fadeIn {
  to { opacity: 1; }
}
@keyframes zonePulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(217, 77, 77, 0.35); }
  50% { box-shadow: 0 0 0 6px rgba(217, 77, 77, 0.12); }
}

@keyframes blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }

@media (max-width: 640px) {
  .ai-chatbot { right: 12px; bottom: 12px; }
  .ai-chat-panel { width: calc(100vw - 20px); height: min(580px, calc(100vh - 80px)); }
}
</style>

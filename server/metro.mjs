import { readFileSync, existsSync } from 'node:fs'
import { circle, featureCollection, union } from '@turf/turf'

const WALK_MPS = 1.15
const RIDE_MPS = 11.5
const BOARD_WAIT_SEC = 90
const MIN_TRANSFER_SEC = 75
const MAX_RIDE_METERS = 12000

class Heap {
  constructor() {
    this.items = []
  }

  get size() {
    return this.items.length
  }

  push(item) {
    const items = this.items
    items.push(item)
    let index = items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if (items[parent][0] <= items[index][0]) break
      ;[items[parent], items[index]] = [items[index], items[parent]]
      index = parent
    }
  }

  pop() {
    const items = this.items
    const top = items[0]
    const last = items.pop()
    if (items.length > 0 && last) {
      items[0] = last
      let index = 0
      for (;;) {
        const left = index * 2 + 1
        const right = left + 1
        let smallest = index
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right
        if (smallest === index) break
        ;[items[smallest], items[index]] = [items[index], items[smallest]]
        index = smallest
      }
    }
    return top
  }
}

export function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371000
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dp = ((lat2 - lat1) * Math.PI) / 180
  const dl = ((lon2 - lon1) * Math.PI) / 180
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(a))
}

function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\s+/g, ' ')
    .trim()
}

function addEdge(map, from, to, seconds) {
  if (from === to) return
  const list = map.get(from)
  if (!list) {
    map.set(from, [{ to, seconds }])
    return
  }
  const existing = list.find((edge) => edge.to === to)
  if (!existing) list.push({ to, seconds })
  else if (seconds < existing.seconds) existing.seconds = seconds
}

function keepRelation(tags) {
  const route = tags.route || ''
  const blob = `${tags.name || ''} ${tags.network || ''} ${tags.operator || ''}`
  if (route === 'subway') return true
  return /мцк|центральное кольцо|метро/i.test(blob)
}

function loadDump(file) {
  if (!existsSync(file)) return []
  try {
    const dump = JSON.parse(readFileSync(file, 'utf8'))
    return dump.elements || []
  } catch (error) {
    console.warn(`пропускаю ${file}: ${error instanceof Error ? error.message : error}`)
    return []
  }
}

export function loadMetro(files) {
  const elements = files.flatMap(loadDump)
  const nodes = new Map()
  const relations = []
  for (const element of elements) {
    if (element.type === 'node') nodes.set(element.id, element)
    else if (element.type === 'relation' && keepRelation(element.tags || {})) relations.push(element)
  }

  const stations = new Map()
  const rides = new Map()

  function remember(id) {
    const node = nodes.get(id)
    if (!node || node.lat == null || node.lon == null) return null
    if (!stations.has(id)) {
      stations.set(id, {
        id,
        name: node.tags?.name || '',
        lat: node.lat,
        lon: node.lon,
      })
    }
    return stations.get(id)
  }

  function connect(fromId, toId) {
    const from = remember(fromId)
    const to = remember(toId)
    if (!from || !to) return
    const distance = haversine(from.lat, from.lon, to.lat, to.lon)
    if (distance < 40 || distance > MAX_RIDE_METERS) return
    const seconds = Math.max(50, Math.round(distance / RIDE_MPS + 20))
    addEdge(rides, from.id, to.id, seconds)
    addEdge(rides, to.id, from.id, seconds)
  }

  const lineNames = []
  for (const relation of relations) {
    const tags = relation.tags || {}
    const stopIds = []
    for (const member of relation.members || []) {
      if (member.type !== 'node') continue
      if (!String(member.role || '').includes('stop')) continue
      stopIds.push(member.ref)
    }
    if (stopIds.length < 2) continue
    lineNames.push(tags.name || tags.ref || 'линия')
    let previous = null
    for (const id of stopIds) {
      if (!nodes.has(id)) {
        previous = null
        continue
      }
      if (previous != null) connect(previous, id)
      previous = id
    }
    const ring = tags.roundtrip === 'yes' || /кольц/i.test(tags.name || '')
    if (ring && stopIds.length > 2) connect(stopIds[stopIds.length - 1], stopIds[0])
  }

  const transfers = new Map()
  const list = [...stations.values()]
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i]
      const b = list[j]
      const distance = haversine(a.lat, a.lon, b.lat, b.lon)
      const sameName = normalizeName(a.name) && normalizeName(a.name) === normalizeName(b.name)
      const close = distance <= 360 || (sameName && distance <= 850)
      if (!close) continue
      const seconds = Math.round(
        Math.min(600, Math.max(MIN_TRANSFER_SEC, distance / 1.05 + 50)),
      )
      addEdge(transfers, a.id, b.id, seconds)
      addEdge(transfers, b.id, a.id, seconds)
    }
  }

  return { stations, rides, transfers, lineNames: [...new Set(lineNames)] }
}

export function rideMinutes(graph, fromName, toName) {
  const sources = [...graph.stations.values()].filter((station) => station.name === fromName)
  const targets = new Set(
    [...graph.stations.values()].filter((station) => station.name === toName).map((station) => station.id),
  )
  if (!sources.length || !targets.size) return null
  let best = Infinity
  for (const source of sources) {
    const minutes = earliestRide(graph, source.id, targets)
    if (minutes != null && minutes < best) best = minutes
  }
  return Number.isFinite(best) ? best : null
}

function earliestRide(graph, originId, targets) {
  const best = new Map()
  const heap = new Heap()
  const start = BOARD_WAIT_SEC
  best.set(`${originId}:1`, start)
  heap.push([start, originId])
  while (heap.size) {
    const [time, id] = heap.pop()
    if (best.get(`${id}:1`) !== time) continue
    if (targets.has(id) && id !== originId) return Math.round(time / 60)
    for (const edge of graph.rides.get(id) || []) relax(best, heap, edge.to, time + edge.seconds)
    for (const edge of graph.transfers.get(id) || []) relax(best, heap, edge.to, time + edge.seconds)
  }
  return null
}

function relax(best, heap, id, time) {
  const key = `${id}:1`
  const previous = best.get(key)
  if (previous != null && previous <= time) return
  best.set(key, time)
  heap.push([time, id])
}

export function metroIsochrone(graph, lat, lon, minutes) {
  const budget = Math.round(minutes * 60)
  const best = new Map()
  const egress = new Map()
  const heap = new Heap()

  for (const station of graph.stations.values()) {
    const walk = haversine(lat, lon, station.lat, station.lon) / WALK_MPS
    if (walk >= budget) continue
    relaxState(best, heap, station.id, 0, Math.round(walk), false, egress, budget)
  }

  while (heap.size) {
    const [time, id, phase] = heap.pop()
    const key = `${id}:${phase}`
    if (best.get(key) !== time) continue
    if (phase === 0) {
      relaxState(best, heap, id, 1, time + BOARD_WAIT_SEC, false, egress, budget)
      continue
    }
    for (const edge of graph.rides.get(id) || []) {
      relaxState(best, heap, edge.to, 1, time + edge.seconds, true, egress, budget)
    }
    for (const edge of graph.transfers.get(id) || []) {
      relaxState(best, heap, edge.to, 1, time + edge.seconds, true, egress, budget)
    }
  }

  const circles = []
  for (const [id, arrival] of egress) {
    const remain = budget - arrival
    if (remain < 30) continue
    const station = graph.stations.get(id)
    const radiusKm = (remain * WALK_MPS) / 1000
    circles.push(circle([station.lon, station.lat], radiusKm, { steps: 36, units: 'kilometers' }))
  }
  if (!circles.length) return { feature: null, stations: 0 }
  const merged = circles.length === 1 ? circles[0] : union(featureCollection(circles))
  if (merged) merged.properties = { mode: 'metro' }
  return { feature: merged, stations: egress.size }
}

function relaxState(best, heap, id, phase, time, viaRide, egress, budget) {
  time = Math.round(time)
  if (time > budget) return
  const key = `${id}:${phase}`
  const previous = best.get(key)
  if (previous != null && previous <= time) return
  best.set(key, time)
  if (phase === 1 && viaRide) egress.set(id, time)
  heap.push([time, id, phase])
}

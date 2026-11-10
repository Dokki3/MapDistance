import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

const EMPTY = { type: 'FeatureCollection', features: [] }
const LAYERS = [
  { id: 'car', color: '#007aff' },
  { id: 'metro', color: '#af52de' },
  { id: 'walk', color: '#34c759' },
]

const hint = document.querySelector('#hint')
const banner = document.querySelector('#banner')
const legendTitle = document.querySelector('#legend-title')
const callout = document.querySelector('#callout')
const timeValue = document.querySelector('#time-value')
const timeRange = document.querySelector('#time-range')
const buildButton = document.querySelector('#build')
const status = document.querySelector('#status')

const pin = document.createElement('div')
pin.className = 'pin'
pin.innerHTML = `
  <svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true">
    <path fill="#ff3b30" d="M16 0C7.2 0 0 7.2 0 16c0 11.2 16 26 16 26s16-14.8 16-26C32 7.2 24.8 0 16 0z"/>
    <circle cx="16" cy="16" r="6" fill="#fff"/>
  </svg>`

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [37.618, 55.756],
  zoom: 11.2,
  attributionControl: false,
})

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
map.dragRotate.disable()
map.touchZoomRotate.disableRotation()

const marker = new maplibregl.Marker({ element: pin, anchor: 'bottom' })
const popup = new maplibregl.Popup({
  closeButton: false,
  closeOnClick: false,
  maxWidth: '300px',
  className: 'apple-popup',
  offset: {
    bottom: [0, -44],
    top: [0, 8],
    left: [16, -16],
    right: [-16, -16],
  },
}).setDOMContent(callout)

let point = null
let requestId = 0

paintRange()
timeRange.addEventListener('input', () => {
  timeValue.textContent = timeRange.value
  paintRange()
  status.textContent = ''
  status.classList.remove('warn')
})

document.querySelector('#zoom-in').addEventListener('click', () => map.zoomIn())
document.querySelector('#zoom-out').addEventListener('click', () => map.zoomOut())
callout.querySelector('#close').addEventListener('click', () => {
  popup.remove()
  marker.remove()
  point = null
  hint.textContent = 'Нажмите на карту'
})
buildButton.addEventListener('click', () => calculate())
callout.addEventListener('click', (event) => event.stopPropagation())
callout.addEventListener('pointerdown', (event) => event.stopPropagation())

map.on('load', () => {
  const before = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id
  for (const layer of LAYERS) {
    map.addSource(layer.id, { type: 'geojson', data: EMPTY })
    map.addLayer(
      {
        id: `${layer.id}-fill`,
        type: 'fill',
        source: layer.id,
        paint: { 'fill-color': layer.color, 'fill-opacity': 0.25 },
      },
      before,
    )
    map.addLayer(
      {
        id: `${layer.id}-line`,
        type: 'line',
        source: layer.id,
        paint: { 'line-color': layer.color, 'line-width': 1.4, 'line-opacity': 0.85 },
      },
      before,
    )
  }
})

map.getContainer().addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest('#callout, .maplibregl-ctrl, .maplibregl-popup')) return
  const rect = map.getCanvas().getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top
  if (x < 0 || y < 0 || x > rect.width || y > rect.height) return
  place(map.unproject([x, y]))
}, true)

function place(lngLat) {
  point = lngLat
  marker.setLngLat(point).addTo(map)
  popup.setLngLat(point).addTo(map)
  hint.textContent = 'Выберите время и постройте области'
  status.textContent = ''
  status.classList.remove('warn')
}

async function calculate() {
  if (!point) return
  const minutes = Number(timeRange.value)
  const current = ++requestId
  buildButton.disabled = true
  buildButton.textContent = 'Считаем…'
  status.textContent = 'Пешком, метро и машина'
  status.classList.remove('warn')

  try {
    const response = await fetch('/api/isochrones', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat: point.lat, lon: point.lng, minutes }),
    })
    const payload = await response.json()
    if (current !== requestId) return
    if (!response.ok) throw new Error(payload.error || 'Не удалось посчитать')

    for (const layer of LAYERS) {
      map.getSource(layer.id)?.setData(asCollection(payload[layer.id]))
    }
    legendTitle.textContent = `За ${minutes} мин`
    const ready = LAYERS.filter((layer) => asCollection(payload[layer.id]).features.length).length
    status.textContent = payload.warnings?.[0] || `${ready} ${areaWord(ready)}`
    status.classList.toggle('warn', Boolean(payload.warnings?.length))
    fitTo(payload)
  } catch (error) {
    if (current !== requestId) return
    status.textContent = error instanceof Error ? error.message : 'Ошибка расчёта'
    status.classList.add('warn')
  } finally {
    if (current === requestId) {
      buildButton.disabled = false
      buildButton.textContent = 'Показать области'
    }
  }
}

function asCollection(value) {
  if (!value) return EMPTY
  if (value.type === 'FeatureCollection') return value
  if (value.type === 'Feature') return { type: 'FeatureCollection', features: [value] }
  return EMPTY
}

function fitTo(payload) {
  const bounds = new maplibregl.LngLatBounds()
  let found = false
  for (const layer of LAYERS) {
    const collection = asCollection(payload[layer.id])
    for (const feature of collection.features) {
      walkCoords(feature.geometry?.coordinates, (coord) => {
        bounds.extend(coord)
        found = true
      })
    }
  }
  if (!found || bounds.isEmpty()) return
  map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 700 })
}

function walkCoords(coords, visit) {
  if (!coords) return
  if (typeof coords[0] === 'number') {
    visit(coords)
    return
  }
  for (const child of coords) walkCoords(child, visit)
}

function areaWord(count) {
  if (count === 1) return 'область'
  if (count > 1 && count < 5) return 'области'
  return 'областей'
}

function paintRange() {
  const min = Number(timeRange.min)
  const max = Number(timeRange.max)
  const value = Number(timeRange.value)
  const percent = ((value - min) / (max - min)) * 100
  timeRange.style.setProperty('--fill', `${percent}%`)
}

async function watchRoads() {
  try {
    const response = await fetch('/api/health')
    const health = await response.json()
    if (health.valhalla) {
      banner.hidden = true
      return
    }
    banner.hidden = false
    banner.textContent = 'Собираем дороги Москвы. Метро уже можно смотреть, пешком и машина появятся сами.'
  } catch {
    banner.hidden = false
    banner.textContent = 'Сервер расчёта ещё запускается.'
  }
  window.setTimeout(watchRoads, 4000)
}

watchRoads()

import express from 'express'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMetro, metroIsochrone, rideMinutes } from './metro.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '0.0.0.0'
const valhallaUrl = process.env.VALHALLA_URL || 'http://127.0.0.1:8002'
const distDir = join(root, 'dist')

const metroFiles = [join(root, 'data/metro-overpass.json'), join(root, 'data/mcc-overpass.json')]
const graph = loadMetro(metroFiles)

console.log(
  `метро: ${graph.stations.size} станций, ${graph.lineNames.length} маршрутов`,
)
for (const pair of [
  ['Сходненская', 'Нахимовский проспект'],
  ['Университет', 'Нахимовский проспект'],
]) {
  const minutes = rideMinutes(graph, pair[0], pair[1])
  console.log(`  ${pair[0]} → ${pair[1]}: ${minutes == null ? 'нет пути' : `${minutes} мин`}`)
}

const app = express()
app.use(express.json())

app.get('/api/health', async (_request, response) => {
  response.json({
    metroStations: graph.stations.size,
    lines: graph.lineNames.length,
    valhalla: await valhallaReady(),
  })
})

app.post('/api/isochrones', async (request, response) => {
  const lat = Number(request.body?.lat)
  const lon = Number(request.body?.lon)
  const minutes = Number(request.body?.minutes)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(minutes)) {
    response.status(400).json({ error: 'Нужны координаты и время' })
    return
  }
  if (minutes < 5 || minutes > 90) {
    response.status(400).json({ error: 'Время от 5 до 90 минут' })
    return
  }

  const warnings = []
  const [walkResult, carResult, metroResult] = await Promise.all([
    roadIsochrone('pedestrian', lat, lon, minutes),
    roadIsochrone('auto', lat, lon, minutes),
    Promise.resolve().then(() => metroIsochrone(graph, lat, lon, minutes)),
  ])

  if (walkResult.error) warnings.push('Пешая зона пока недоступна: дорожный граф ещё собирается.')
  if (carResult.error) warnings.push('Зона на машине пока недоступна: дорожный граф ещё собирается.')
  if (!metroResult.feature) warnings.push('За это время метро отсюда не достаёт ни одной другой станции.')

  response.json({
    minutes,
    reachableStations: metroResult.stations,
    walk: walkResult.feature,
    metro: metroResult.feature,
    car: carResult.feature,
    warnings: [...new Set(warnings)],
  })
})

async function valhallaReady() {
  try {
    const result = await fetch(`${valhallaUrl}/status`, { signal: AbortSignal.timeout(1500) })
    return result.ok
  } catch {
    return false
  }
}

async function roadIsochrone(costing, lat, lon, minutes) {
  try {
    const result = await fetch(`${valhallaUrl}/isochrone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        locations: [{ lat, lon }],
        costing,
        contours: [{ time: minutes }],
        polygons: true,
        denoise: costing === 'pedestrian' ? 0 : 0.25,
        generalize: costing === 'pedestrian' ? 18 : 55,
      }),
    })
    if (!result.ok) {
      const text = await result.text()
      return { feature: null, error: text.slice(0, 240) }
    }
    const payload = await result.json()
    return { feature: areasOnly(payload) }
  } catch (error) {
    return { feature: null, error: error instanceof Error ? error.message : 'valhalla' }
  }
}

function areasOnly(payload) {
  if (!payload || payload.type !== 'FeatureCollection') return null
  const features = (payload.features || []).filter((feature) => {
    const type = feature.geometry?.type
    return type === 'Polygon' || type === 'MultiPolygon'
  })
  if (!features.length) return null
  return { type: 'FeatureCollection', features }
}

if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => {
    response.sendFile(join(distDir, 'index.html'))
  })
}

app.listen(port, host, () => {
  console.log(`app http://${host}:${port}`)
})

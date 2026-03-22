figma.showUI(__html__, { width: 400, height: 680 })

// ── Types ──────────────────────────────────────────────────────────────

interface ExportedComponent {
  id: string
  name: string
  description: string
  figmaComponentKey: string
  category: string
  variants: ExportedVariant[]
  variantProperties: string[]
  hasIcon: boolean
  hasLabel: boolean
  thumbnail?: string
}

interface TokenCssBinding {
  tokenPath: string
  cssProperty: string
}

interface ExportedVariant {
  id: string
  name: string
  variantProperties: Record<string, string>
  tokensUsed: Record<string, string[]>
  tokenBindings: TokenCssBinding[]
  description: string
  /** Preview for this variant (component sets only) */
  thumbnail?: string
}

interface ExportedIcon {
  id: string
  name: string
  figmaComponentId: string
  isFigmaComponent: boolean
  hasStrokes: boolean
  width: number
  height: number
}

interface TypographyEntry {
  name: string
  fontSize: string
  fontFamily: string
  fontWeight: number
  lineHeight: string
  letterSpacing: string
}

interface ScanResult {
  tokenCount: number
  colorCount: number
  dimensionCount: number
  componentCount: number
  variantCount: number
  iconCount: number
  shadowCount: number
  typographyCount: number
  components: { name: string; variantCount: number }[]
  icons: string[]
}

// ── Message handler ────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'load-prefs') {
    const [apiKey, repo, filePath, endpointUrl] = await Promise.all([
      figma.clientStorage.getAsync('apiKey'),
      figma.clientStorage.getAsync('repo'),
      figma.clientStorage.getAsync('filePath'),
      figma.clientStorage.getAsync('endpointUrl'),
    ])
    figma.ui.postMessage({ type: 'prefs', apiKey, repo, filePath, endpointUrl })
  }

  if (msg.type === 'save-prefs') {
    await figma.clientStorage.setAsync('apiKey', msg.apiKey)
    await figma.clientStorage.setAsync('repo', msg.repo)
    await figma.clientStorage.setAsync('filePath', msg.filePath)
    if (msg.endpointUrl !== undefined) {
      await figma.clientStorage.setAsync('endpointUrl', msg.endpointUrl)
    }
  }

  if (msg.type === 'scan') {
    const scanResult = await scanDocument()
    figma.ui.postMessage({ type: 'scan-result', ...scanResult })
  }

  if (msg.type === 'export') {
    const { apiKey, repo, filePath, mergeStrategy, commitMessage } = msg

    try {
      const { tokens, variableCollections, primaryExportMode } = extractTokens()
      const components = await extractComponents()
      const icons = extractIcons()
      const shadows = extractShadows()
      const typography = extractTypography()

      const metadata = {
        figmaFileId: figma.root.id,
        figmaFileName: figma.root.name,
        exportedAt: new Date().toISOString(),
        variableCollections,
        primaryExportMode,
      }

      figma.ui.postMessage({
        type: 'do-export',
        tokens,
        components,
        icons,
        shadows,
        typography,
        metadata,
        apiKey,
        repo,
        filePath,
        mergeStrategy,
        commitMessage,
      })
    } catch (err) {
      figma.ui.postMessage({
        type: 'export-error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  if (msg.type === 'close') {
    figma.closePlugin()
  }
}

// ── Token extraction (existing logic, refactored) ──────────────────────

/** Stable JSON key per Figma variable collection (avoids name collisions). */
function figmaCollectionKey(collection: VariableCollection): string {
  const slug =
    collection.name
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'collection'
  const idPart = collection.id.includes(':') ? collection.id.split(':').pop()! : collection.id
  return `${slug}_${idPart}`.replace(/_+/g, '_')
}

/** True when object is a map of Figma mode name → DTCG leaf (not e.g. stone → 100, 200). */
function isModeMapLeafPlugin(o: unknown, knownModeNames: Set<string>): boolean {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const node = o as Record<string, unknown>
  const keys = Object.keys(node).filter((k) => !k.startsWith('$'))
  if (keys.length === 0) return false
  const everyDtcg = keys.every((k) => {
    const v = node[k]
    return (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      '$type' in (v as object) &&
      '$value' in (v as object)
    )
  })
  if (!everyDtcg) return false
  if (knownModeNames.size > 0) {
    return keys.every((k) => knownModeNames.has(k))
  }
  const looksLikeTokenPathSegmentKey = (k: string) =>
    /^[0-9]+$/.test(k) ||
    /^(xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl)$/i.test(k) ||
    /^[0-9]+(\.[0-9]+)?(px|rem)$/i.test(k)
  if (keys.every(looksLikeTokenPathSegmentKey)) return false
  return true
}

function extractTokens(): {
  tokens: Record<string, unknown>
  variableCollections: { name: string; modes: { modeId: string; name: string }[] }[]
  primaryExportMode: string | null
} {
  const collections = figma.variables.getLocalVariableCollections()
  const output: Record<string, unknown> = {}
  const variableCollections: { name: string; modes: { modeId: string; name: string }[] } = []

  let primaryExportMode: string | null = null

  for (const collection of collections) {
    const modes = collection.modes
    if (modes.length === 0) continue

    variableCollections.push({
      name: collection.name,
      modes: modes.map((m) => ({ modeId: m.modeId, name: m.name })),
    })
    if (primaryExportMode === null) primaryExportMode = modes[0].name

    const collKey = figmaCollectionKey(collection)
    const collRoot: Record<string, unknown> = {}
    const knownModeNames = new Set(modes.map((m) => m.name))

    for (const variableId of collection.variableIds) {
      const variable = figma.variables.getVariableById(variableId)
      if (!variable) continue

      const byMode: Record<string, unknown> = {}
      for (const mode of modes) {
        const raw = variable.valuesByMode[mode.modeId]
        const { value, type } = resolveValue(raw, variable.resolvedType, collections, new Set())
        if (value === null) continue
        byMode[mode.name] = { $type: type, $value: value }
      }
      if (Object.keys(byMode).length === 0) continue

      const path = variable.name.replace(/\//g, '.')
      setNested(collRoot, path, byMode, knownModeNames)
    }

    if (Object.keys(collRoot).length > 0) {
      output[collKey] = collRoot
    }
  }

  return { tokens: output, variableCollections, primaryExportMode }
}

// ── Component extraction ───────────────────────────────────────────────

const THUMBNAIL_MAX_PX = 400

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function uint8ToBase64(bytes: Uint8Array): string {
  const len = bytes.length
  const rem = len % 3
  const mainLen = len - rem
  const parts: string[] = []

  for (let i = 0; i < mainLen; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    parts.push(B64[(n >> 18) & 63], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63])
  }

  if (rem === 1) {
    const n = bytes[mainLen]
    parts.push(B64[n >> 2], B64[(n << 4) & 63], '=', '=')
  } else if (rem === 2) {
    const n = (bytes[mainLen] << 8) | bytes[mainLen + 1]
    parts.push(B64[n >> 10], B64[(n >> 4) & 63], B64[(n << 2) & 63], '=')
  }

  return parts.join('')
}

/** True if this node sits under a Component Set (variant def or nested comp inside a variant). */
function isUnderComponentSet(node: BaseNode): boolean {
  let p: BaseNode | null = node.parent
  while (p) {
    if (p.type === 'COMPONENT_SET') return true
    p = p.parent
  }
  return false
}

/**
 * Slash-name heuristic (bootstrap / non–component-set masters):
 * Group when any path segment contains `=`. Otherwise keep full name as standalone.
 * e.g. `Icons/Arrow` → standalone; `Alert/Variant=Danger` → base `Alert`.
 */
function parseComponentName(name: string): { baseName: string; variantProps: Record<string, string> } {
  const parts = name.split('/')
  const variantParts = parts.filter((p) => p.includes('='))

  if (variantParts.length === 0) {
    return { baseName: name, variantProps: {} }
  }

  const firstVariantIndex = parts.findIndex((p) => p.includes('='))
  const baseName = parts.slice(0, firstVariantIndex).join('/')

  const variantProps: Record<string, string> = {}
  for (const part of variantParts) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key && value) variantProps[key] = value
  }

  return { baseName: baseName || name, variantProps }
}

interface RawStandaloneEntry {
  id: string
  name: string
  description: string
  figmaComponentKey: string
  tokensUsed: Record<string, string[]>
  tokenBindings: TokenCssBinding[]
  thumbnail?: string
  hasIcon: boolean
  hasLabel: boolean
}

function inferVariantAxesFromVariants(variants: ExportedVariant[]): string[] {
  const keys = new Set<string>()
  for (const v of variants) {
    for (const k of Object.keys(v.variantProperties ?? {})) {
      keys.add(k)
    }
  }
  return [...keys]
}

/** Merge standalone COMPONENT masters that share a slash + `=` base name (e.g. Basalt bootstrap). */
function groupStandaloneBySlashName(entries: RawStandaloneEntry[]): ExportedComponent[] {
  const groups = new Map<
    string,
    { baseName: string; first: RawStandaloneEntry; variants: ExportedVariant[] }
  >()

  for (const comp of entries) {
    const { baseName, variantProps } = parseComponentName(comp.name)
    if (!groups.has(baseName)) {
      groups.set(baseName, { baseName, first: comp, variants: [] })
    }
    const g = groups.get(baseName)!
    g.variants.push({
      id: comp.id,
      name: comp.name,
      variantProperties: variantProps,
      tokensUsed: comp.tokensUsed,
      tokenBindings: comp.tokenBindings,
      description: comp.description,
      thumbnail: comp.thumbnail,
    })
  }

  return Array.from(groups.values()).map((g) => ({
    id: g.first.id,
    name: g.baseName,
    description: g.first.description,
    figmaComponentKey: g.first.figmaComponentKey,
    category: guessCategory(g.baseName),
    variants: g.variants,
    variantProperties: inferVariantAxesFromVariants(g.variants),
    hasIcon: g.first.hasIcon,
    hasLabel: g.first.hasLabel,
    thumbnail: g.variants[0]?.thumbnail ?? g.first.thumbnail,
  }))
}

async function buildRawStandaloneEntry(comp: ComponentNode): Promise<RawStandaloneEntry> {
  const { categories, cssBindings } = getTokenBindings(comp)
  const thumbnail = await exportThumbnail(comp)
  return {
    id: comp.id,
    name: comp.name,
    description: comp.description || '',
    figmaComponentKey: comp.key,
    tokensUsed: categories,
    tokenBindings: cssBindings,
    thumbnail,
    hasIcon: detectHasIcon(comp),
    hasLabel: detectHasLabel(comp),
  }
}

async function exportThumbnail(node: SceneNode): Promise<string | undefined> {
  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: {
        type: 'WIDTH',
        value: Math.min(Math.round(node.width * 2), THUMBNAIL_MAX_PX),
      },
    })
    return `data:image/png;base64,${uint8ToBase64(bytes)}`
  } catch {
    return undefined
  }
}

async function extractComponents(): Promise<ExportedComponent[]> {
  const results: ExportedComponent[] = []
  // 1) Native Figma component sets (Combine as variants).
  const componentSets = figma.root.findAll((n) => n.type === 'COMPONENT_SET') as ComponentSetNode[]
  // 2) Standalone COMPONENT masters (bootstrap: slash + `=` names grouped by parseComponentName).
  const standaloneComponents = figma.root.findAll(
    (n) => n.type === 'COMPONENT' && !isUnderComponentSet(n),
  ) as ComponentNode[]

  for (const set of componentSets) {
    results.push(await extractComponentSet(set))
  }

  const rawStandalone: RawStandaloneEntry[] = []
  for (const comp of standaloneComponents) {
    if (isIconComponent(comp)) continue
    rawStandalone.push(await buildRawStandaloneEntry(comp))
  }
  results.push(...groupStandaloneBySlashName(rawStandalone))

  return results
}

async function extractComponentSet(set: ComponentSetNode): Promise<ExportedComponent> {
  const propDefs = set.componentPropertyDefinitions
  const variantAxes: string[] = []
  for (const [name, def] of Object.entries(propDefs)) {
    if (def.type === 'VARIANT') variantAxes.push(name)
  }

  const variants: ExportedVariant[] = []
  for (const child of set.children) {
    if (child.type !== 'COMPONENT') continue
    const comp = child as ComponentNode
    const vProps: Record<string, string> = {}
    if (comp.variantProperties) {
      for (const [k, v] of Object.entries(comp.variantProperties)) {
        if (v != null) vProps[k] = v
      }
    }
    const { categories, cssBindings } = getTokenBindings(comp)
    const variantThumb = await exportThumbnail(comp)
    // Use Figma layer name (unique per variant) for stable DB keys; display labels come from variantProperties
    variants.push({
      id: comp.id,
      name: comp.name,
      variantProperties: vProps,
      tokensUsed: categories,
      tokenBindings: cssBindings,
      description: comp.description || '',
      thumbnail: variantThumb,
    })
  }

  const thumbnailNode = set.children.find((c) => c.type === 'COMPONENT') ?? set
  const thumbnail = await exportThumbnail(thumbnailNode as SceneNode)

  return {
    id: set.id,
    name: set.name,
    description: set.description || '',
    figmaComponentKey: set.key,
    category: guessCategory(set.name),
    variants,
    variantProperties: variantAxes,
    hasIcon: detectHasIcon(set),
    hasLabel: detectHasLabel(set),
    thumbnail,
  }
}

const FIGMA_PROP_TO_CSS: Record<string, string> = {
  fills: 'background-color',
  strokes: 'border-color',
  topLeftRadius: 'border-radius',
  topRightRadius: 'border-radius',
  bottomLeftRadius: 'border-radius',
  bottomRightRadius: 'border-radius',
  cornerRadius: 'border-radius',
  paddingLeft: 'padding-x',
  paddingRight: 'padding-x',
  paddingTop: 'padding-y',
  paddingBottom: 'padding-y',
  itemSpacing: 'gap',
  opacity: 'opacity',
  fontSize: 'font-size',
  fontFamily: 'font-family',
  fontWeight: 'font-weight',
  lineHeight: 'line-height',
  letterSpacing: 'letter-spacing',
  width: 'width',
  height: 'height',
  minWidth: 'min-width',
  minHeight: 'min-height',
  maxWidth: 'max-width',
  maxHeight: 'max-height',
}

function figmaPropToCss(figmaProp: string, resolvedType: string): string {
  if (FIGMA_PROP_TO_CSS[figmaProp]) return FIGMA_PROP_TO_CSS[figmaProp]
  if (resolvedType === 'COLOR') return 'color'
  if (resolvedType === 'FLOAT') return 'padding-x'
  return 'background-color'
}

interface BindingCollector {
  categories: Record<string, Set<string>>
  cssBindings: TokenCssBinding[]
  seenBindings: Set<string>
}

function getTokenBindings(node: SceneNode): { categories: Record<string, string[]>; cssBindings: TokenCssBinding[] } {
  const collector: BindingCollector = {
    categories: {
      colors: new Set<string>(),
      spacing: new Set<string>(),
      typography: new Set<string>(),
    },
    cssBindings: [],
    seenBindings: new Set<string>(),
  }

  walkBindings(node, collector, true)

  const categories: Record<string, string[]> = {}
  for (const [cat, set] of Object.entries(collector.categories)) {
    if (set.size > 0) categories[cat] = Array.from(set)
  }
  return { categories, cssBindings: collector.cssBindings }
}

function walkBindings(
  node: SceneNode,
  collector: BindingCollector,
  isRoot: boolean,
): void {
  if ('boundVariables' in node) {
    const bv = (node as any).boundVariables as Record<string, any> | undefined
    if (bv) {
      for (const [prop, binding] of Object.entries(bv)) {
        const ids = Array.isArray(binding) ? binding : [binding]
        for (const b of ids) {
          if (!b?.id) continue
          const variable = figma.variables.getVariableById(b.id)
          if (!variable) continue
          const path = variable.name.replace(/\//g, '.')
          const type = variable.resolvedType
          if (type === 'COLOR') collector.categories.colors.add(path)
          else if (type === 'FLOAT') collector.categories.spacing.add(path)
          else if (type === 'STRING') collector.categories.typography.add(path)

          const cssProperty = isRoot
            ? figmaPropToCss(prop, type)
            : inferCssFromChildContext(node, prop, type)

          const key = `${cssProperty}::${path}`
          if (!collector.seenBindings.has(key)) {
            collector.seenBindings.add(key)
            collector.cssBindings.push({ tokenPath: path, cssProperty })
          }
        }
      }
    }
  }

  if ('fills' in node && Array.isArray((node as any).fills)) {
    for (const rawFill of (node as any).fills) {
      const fill = rawFill as any
      if (fill.boundVariables?.color) {
        const variable = figma.variables.getVariableById(
          fill.boundVariables.color.id as string,
        )
        if (variable) {
          const path = variable.name.replace(/\//g, '.')
          collector.categories.colors.add(path)
          const cssProperty = isRoot ? 'background-color' : 'color'
          const key = `${cssProperty}::${path}`
          if (!collector.seenBindings.has(key)) {
            collector.seenBindings.add(key)
            collector.cssBindings.push({ tokenPath: path, cssProperty })
          }
        }
      }
    }
  }

  if ('children' in node) {
    for (const child of (node as ChildrenMixin).children) {
      walkBindings(child as SceneNode, collector, false)
    }
  }
}

function inferCssFromChildContext(node: SceneNode, prop: string, resolvedType: string): string {
  if (prop === 'fills') {
    if (node.type === 'TEXT') return 'color'
    return 'background-color'
  }
  if (FIGMA_PROP_TO_CSS[prop]) return FIGMA_PROP_TO_CSS[prop]
  if (resolvedType === 'COLOR') {
    return node.type === 'TEXT' ? 'color' : 'background-color'
  }
  return figmaPropToCss(prop, resolvedType)
}

function detectHasIcon(node: SceneNode): boolean {
  if ('children' in node) {
    return (node as ChildrenMixin).children.some(
      (c) =>
        c.name.toLowerCase().includes('icon') ||
        c.type === 'INSTANCE',
    )
  }
  return false
}

function detectHasLabel(node: SceneNode): boolean {
  if ('children' in node) {
    return (node as ChildrenMixin).children.some(
      (c) => c.type === 'TEXT',
    )
  }
  return false
}

function guessCategory(name: string): string {
  const lower = name.toLowerCase()
  if (/button|cta|link|tab|toggle|switch|chip/.test(lower)) return 'interactive'
  if (/input|text.?field|select|dropdown|checkbox|radio|form/.test(lower)) return 'form'
  if (/card|container|section|layout|grid|stack/.test(lower)) return 'layout'
  if (/modal|dialog|drawer|sheet|popover|tooltip|toast/.test(lower)) return 'overlay'
  if (/nav|menu|sidebar|header|footer|breadcrumb/.test(lower)) return 'navigation'
  if (/badge|tag|avatar|icon|image/.test(lower)) return 'display'
  return 'other'
}

// ── Icon extraction ────────────────────────────────────────────────────

function extractIcons(): ExportedIcon[] {
  const icons: ExportedIcon[] = []
  const seen = new Set<string>()

  const allComponents = figma.root.findAll(
    (n) => n.type === 'COMPONENT',
  ) as ComponentNode[]

  for (const comp of allComponents) {
    if (!isIconComponent(comp)) continue
    if (seen.has(comp.name)) continue
    seen.add(comp.name)

    icons.push({
      id: comp.id,
      name: comp.name,
      figmaComponentId: comp.id,
      isFigmaComponent: true,
      hasStrokes: comp.strokes?.length > 0,
      width: Math.round(comp.width),
      height: Math.round(comp.height),
    })
  }

  return icons
}

function isIconComponent(node: SceneNode): boolean {
  const name = node.name.toLowerCase()
  if (name.includes('icon')) return true

  let parent = node.parent
  while (parent) {
    const pName = parent.name.toLowerCase()
    if (pName === 'icons' || pName === 'icon' || pName === 'iconography') return true
    parent = parent.parent
  }

  if ('width' in node && 'height' in node) {
    const n = node as ComponentNode
    if (n.width <= 32 && n.height <= 32 && n.width === n.height) return true
  }

  return false
}

// ── Shadow extraction ──────────────────────────────────────────────────

function extractShadows(): Record<string, string> {
  const shadows: Record<string, string> = {}

  try {
    const styles = figma.getLocalEffectStyles()
    for (const style of styles) {
      const dropShadows = style.effects.filter(
        (e) => e.type === 'DROP_SHADOW' && e.visible !== false,
      )
      if (dropShadows.length === 0) continue

      const cssValues = dropShadows.map((e) => {
        const s = e as DropShadowEffect
        const color = `rgba(${Math.round(s.color.r * 255)}, ${Math.round(s.color.g * 255)}, ${Math.round(s.color.b * 255)}, ${+(s.color.a ?? 1).toFixed(2)})`
        return `${s.offset.x}px ${s.offset.y}px ${s.radius}px ${s.spread ?? 0}px ${color}`
      })

      shadows[style.name] = cssValues.join(', ')
    }
  } catch {
    // getLocalEffectStyles may not be available in all contexts
  }

  return shadows
}

// ── Typography extraction ──────────────────────────────────────────────

function extractTypography(): TypographyEntry[] {
  const entries: TypographyEntry[] = []

  try {
    const styles = figma.getLocalTextStyles()
    for (const style of styles) {
      entries.push({
        name: style.name,
        fontSize: `${style.fontSize}px`,
        fontFamily: style.fontName.family,
        fontWeight: fontWeightFromStyle(style.fontName.style),
        lineHeight: formatLineHeight(style.lineHeight),
        letterSpacing: formatLetterSpacing(style.letterSpacing),
      })
    }
  } catch {
    // getLocalTextStyles may not be available in all contexts
  }

  return entries
}

function fontWeightFromStyle(style: string): number {
  const lower = style.toLowerCase()
  if (lower.includes('thin') || lower.includes('hairline')) return 100
  if (lower.includes('extralight') || lower.includes('ultralight')) return 200
  if (lower.includes('light')) return 300
  if (lower.includes('medium')) return 500
  if (lower.includes('semibold') || lower.includes('demibold')) return 600
  if (lower.includes('extrabold') || lower.includes('ultrabold')) return 800
  if (lower.includes('bold')) return 700
  if (lower.includes('black') || lower.includes('heavy')) return 900
  return 400
}

function formatLineHeight(lh: LineHeight): string {
  if (lh.unit === 'PIXELS') return `${lh.value}px`
  if (lh.unit === 'PERCENT') return `${(lh.value / 100).toFixed(2)}`
  return 'normal'
}

function formatLetterSpacing(ls: LetterSpacing): string {
  if (ls.unit === 'PIXELS') return `${ls.value}px`
  if (ls.unit === 'PERCENT') return `${(ls.value / 100).toFixed(3)}em`
  return '0px'
}

// ── Document scan (lightweight analysis without exporting) ─────────────

function scanComponentCounts(): { count: number; variantCount: number; components: { name: string; variantCount: number }[] } {
  const componentSets = figma.root.findAll((n) => n.type === 'COMPONENT_SET') as ComponentSetNode[]
  const standaloneComponents = figma.root.findAll(
    (n) => n.type === 'COMPONENT' && !isUnderComponentSet(n),
  ) as ComponentNode[]

  const components: { name: string; variantCount: number }[] = []
  let totalVariants = 0

  for (const node of componentSets) {
    const childCount = node.children.filter((c) => c.type === 'COMPONENT').length
    components.push({ name: node.name, variantCount: childCount })
    totalVariants += childCount
  }
  const slashGroups = new Map<string, number>()
  for (const node of standaloneComponents) {
    if (isIconComponent(node)) continue
    const { baseName } = parseComponentName(node.name)
    slashGroups.set(baseName, (slashGroups.get(baseName) ?? 0) + 1)
  }
  for (const [name, vc] of slashGroups) {
    components.push({ name, variantCount: vc })
    totalVariants += vc
  }
  return { count: components.length, variantCount: totalVariants, components }
}

async function scanDocument(): Promise<ScanResult> {
  const collections = figma.variables.getLocalVariableCollections()
  let tokenCount = 0
  let colorCount = 0
  let dimensionCount = 0

  for (const collection of collections) {
    for (const variableId of collection.variableIds) {
      const variable = figma.variables.getVariableById(variableId)
      if (!variable) continue
      tokenCount++
      if (variable.resolvedType === 'COLOR') colorCount++
      else if (variable.resolvedType === 'FLOAT') dimensionCount++
    }
  }

  const compScan = scanComponentCounts()
  const icons = extractIcons()
  let shadowCount = 0
  let typographyCount = 0
  try { shadowCount = figma.getLocalEffectStyles().filter(s => s.effects.some(e => e.type === 'DROP_SHADOW')).length } catch {}
  try { typographyCount = figma.getLocalTextStyles().length } catch {}

  return {
    tokenCount,
    colorCount,
    dimensionCount,
    componentCount: compScan.count,
    variantCount: compScan.variantCount,
    iconCount: icons.length,
    shadowCount,
    typographyCount,
    components: compScan.components,
    icons: icons.map((i) => i.name),
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

const FONT_WEIGHT_NAME_MAP: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
}

function mapFontWeightFromString(s: string): number | null {
  const t = s.trim()
  if (/^\d{2,3}$/.test(t)) {
    const n = parseInt(t, 10)
    if (n >= 100 && n <= 900) return n
  }
  const key = t.replace(/\s+/g, '').toLowerCase()
  for (const [k, v] of Object.entries(FONT_WEIGHT_NAME_MAP)) {
    if (key.includes(k)) return v
  }
  return null
}

function dtcgTypeForVariableResolvedType(rt: VariableResolvedDataType): string {
  switch (rt) {
    case 'COLOR':
      return 'color'
    case 'FLOAT':
      return 'dimension'
    case 'STRING':
      return 'fontFamily'
    case 'BOOLEAN':
      return 'number'
    default:
      return 'unknown'
  }
}

function resolveValue(
  raw: VariableValue,
  resolvedType: VariableResolvedDataType,
  collections: VariableCollection[],
  visited: Set<string>,
): { value: unknown; type: string } {
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'type' in raw &&
    (raw as { type: string }).type === 'VARIABLE_ALIAS'
  ) {
    const aliasId = (raw as { id: string }).id
    if (visited.has(aliasId)) return { value: null, type: 'unknown' }
    visited.add(aliasId)

    const referencedVar = figma.variables.getVariableById(aliasId)
    if (referencedVar) {
      const dtcgPath = referencedVar.name.replace(/\//g, '.')
      return {
        value: `{${dtcgPath}}`,
        type: dtcgTypeForVariableResolvedType(referencedVar.resolvedType),
      }
    }
    return { value: null, type: 'unknown' }
  }

  if (resolvedType === 'COLOR' && typeof raw === 'object' && raw !== null && 'r' in raw) {
    return { value: rgbaToHex(raw as RGBA), type: 'color' }
  }
  if (resolvedType === 'FLOAT') {
    return { value: `${raw}px`, type: 'dimension' }
  }
  if (resolvedType === 'STRING' && typeof raw === 'string') {
    const w = mapFontWeightFromString(raw)
    if (w != null) return { value: w, type: 'fontWeight' }
    return { value: raw, type: 'fontFamily' }
  }
  if (resolvedType === 'BOOLEAN') {
    return { value: raw ? 1 : 0, type: 'number' }
  }
  return { value: raw, type: 'unknown' }
}

function rgbaToHex({ r, g, b, a }: RGBA): string {
  const toHex = (n: number) =>
    Math.round(n * 255)
      .toString(16)
      .padStart(2, '0')
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`
  return a < 1 ? `${hex}${toHex(a)}` : hex
}

function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
  knownModeNames: Set<string>,
): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = current[parts[i]]
    const isLeafNode =
      existing &&
      typeof existing === 'object' &&
      ('$value' in (existing as Record<string, unknown>) ||
        isModeMapLeafPlugin(existing, knownModeNames))
    if (!existing || typeof existing !== 'object' || isLeafNode) {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  const lastKey = parts[parts.length - 1]
  const existingLast = current[lastKey]
  if (
    existingLast &&
    typeof existingLast === 'object' &&
    isModeMapLeafPlugin(existingLast, knownModeNames) &&
    isModeMapLeafPlugin(value, knownModeNames)
  ) {
    current[lastKey] = { ...(existingLast as Record<string, unknown>), ...(value as Record<string, unknown>) }
    return
  }
  current[lastKey] = value
}

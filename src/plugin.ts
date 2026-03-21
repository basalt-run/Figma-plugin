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
      const tokens = extractTokens()
      const components = await extractComponents()
      const icons = extractIcons()
      const shadows = extractShadows()
      const typography = extractTypography()

      const metadata = {
        figmaFileId: figma.root.id,
        figmaFileName: figma.root.name,
        exportedAt: new Date().toISOString(),
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

function extractTokens(): Record<string, unknown> {
  const collections = figma.variables.getLocalVariableCollections()
  const output: Record<string, unknown> = {}

  for (const collection of collections) {
    const mode = collection.modes[0]
    if (!mode) continue

    for (const variableId of collection.variableIds) {
      const variable = figma.variables.getVariableById(variableId)
      if (!variable) continue

      const raw = variable.valuesByMode[mode.modeId]
      const { value, type } = resolveValue(raw, variable.resolvedType, collections, new Set())
      if (value === null) continue

      const path = variable.name.replace(/\//g, '.')
      setNested(output, path, { $type: type, $value: value })
    }
  }

  return output
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
  const allNodes = figma.root.findAll(
    (n) =>
      n.type === 'COMPONENT_SET' ||
      (n.type === 'COMPONENT' && n.parent?.type !== 'COMPONENT_SET'),
  )

  for (const node of allNodes) {
    if (node.type === 'COMPONENT_SET') {
      results.push(await extractComponentSet(node as ComponentSetNode))
    } else if (node.type === 'COMPONENT') {
      if (isIconComponent(node as ComponentNode)) continue
      results.push(await extractStandaloneComponent(node as ComponentNode))
    }
  }

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
    variants.push({
      id: comp.id,
      name: Object.values(vProps).join('/') || comp.name,
      variantProperties: vProps,
      tokensUsed: categories,
      tokenBindings: cssBindings,
      description: comp.description || '',
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

async function extractStandaloneComponent(comp: ComponentNode): Promise<ExportedComponent> {
  const { categories, cssBindings } = getTokenBindings(comp)
  const thumbnail = await exportThumbnail(comp)
  return {
    id: comp.id,
    name: comp.name,
    description: comp.description || '',
    figmaComponentKey: comp.key,
    category: guessCategory(comp.name),
    variants: [
      {
        id: comp.id,
        name: 'default',
        variantProperties: {},
        tokensUsed: categories,
        tokenBindings: cssBindings,
        description: comp.description || '',
      },
    ],
    variantProperties: [],
    hasIcon: detectHasIcon(comp),
    hasLabel: detectHasLabel(comp),
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
  const allNodes = figma.root.findAll(
    (n) =>
      n.type === 'COMPONENT_SET' ||
      (n.type === 'COMPONENT' && n.parent?.type !== 'COMPONENT_SET'),
  )
  const components: { name: string; variantCount: number }[] = []
  let totalVariants = 0
  for (const node of allNodes) {
    if (node.type === 'COMPONENT_SET') {
      const childCount = (node as ComponentSetNode).children.filter((c) => c.type === 'COMPONENT').length
      components.push({ name: node.name, variantCount: childCount })
      totalVariants += childCount
    } else if (node.type === 'COMPONENT') {
      if (isIconComponent(node as ComponentNode)) continue
      components.push({ name: node.name, variantCount: 1 })
      totalVariants += 1
    }
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
      const refCollection = collections.find((c) =>
        c.variableIds.includes(referencedVar.id),
      )
      const refMode = refCollection?.modes[0]
      if (refMode) {
        const refRaw = referencedVar.valuesByMode[refMode.modeId]
        return resolveValue(refRaw, referencedVar.resolvedType, collections, visited)
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
  if (resolvedType === 'STRING') {
    return { value: raw, type: 'fontFamily' }
  }
  if (resolvedType === 'BOOLEAN') {
    return { value: raw, type: 'boolean' }
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
): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = current[parts[i]]
    if (
      !existing ||
      typeof existing !== 'object' ||
      '$value' in (existing as Record<string, unknown>)
    ) {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

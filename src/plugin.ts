figma.showUI(__html__, { width: 380, height: 520 })

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'load-prefs') {
    const [apiKey, repo, filePath] = await Promise.all([
      figma.clientStorage.getAsync('apiKey'),
      figma.clientStorage.getAsync('repo'),
      figma.clientStorage.getAsync('filePath'),
    ])
    figma.ui.postMessage({ type: 'prefs', apiKey, repo, filePath })
  }

  if (msg.type === 'save-prefs') {
    await figma.clientStorage.setAsync('apiKey', msg.apiKey)
    await figma.clientStorage.setAsync('repo', msg.repo)
    await figma.clientStorage.setAsync('filePath', msg.filePath)
  }

  if (msg.type === 'export') {
    const { apiKey, repo, filePath, mergeStrategy, commitMessage } = msg

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

    figma.ui.postMessage({
      type: 'do-export',
      tokens: output,
      apiKey,
      repo,
      filePath,
      mergeStrategy,
      commitMessage,
    })
  }

  if (msg.type === 'close') {
    figma.closePlugin()
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
      const refCollection = collections.find(c =>
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
  value: unknown
): void {
  const parts = path.split('.').filter(Boolean)
  if (parts.length === 0) return
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = current[parts[i]]
    if (!existing || typeof existing !== 'object' || '$value' in (existing as Record<string, unknown>)) {
      current[parts[i]] = {}
    }
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

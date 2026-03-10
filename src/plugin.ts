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
      for (const variableId of collection.variableIds) {
        const variable = figma.variables.getVariableById(variableId)
        if (!variable) continue

        const mode = collection.modes[0]
        const raw = variable.valuesByMode[mode.modeId]

        let value: unknown = raw
        let type = 'unknown'

        if (variable.resolvedType === 'COLOR' && typeof raw === 'object' && raw !== null && 'r' in raw) {
          value = rgbaToHex(raw as RGBA)
          type = 'color'
        } else if (variable.resolvedType === 'FLOAT') {
          value = `${raw}px`
          type = 'dimension'
        } else if (variable.resolvedType === 'STRING') {
          value = raw
          type = 'fontFamily'
        } else if (variable.resolvedType === 'BOOLEAN') {
          value = raw
          type = 'boolean'
        }

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
  const parts = path.split('.')
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {}
    current = current[parts[i]] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

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
    const collections = figma.variables.getLocalVariableCollections()
    const variables = figma.variables.getLocalVariables()

    const varMap = new Map(variables.map((v) => [v.id, v]))
    const output: Record<string, unknown> = {}

    for (const collection of collections) {
      for (const variableId of collection.variableIds) {
        const variable = varMap.get(variableId)
        if (!variable) continue

        const modeId = collection.defaultModeId
        const rawValue = variable.valuesByMode[modeId]

        let value: string | number | undefined
        let type: string

        if (variable.resolvedType === 'COLOR') {
          const c = rawValue as RGBA
          value = rgbaToHex(c)
          type = 'color'
        } else if (variable.resolvedType === 'FLOAT') {
          value = `${rawValue}px`
          type = 'dimension'
        } else if (variable.resolvedType === 'STRING') {
          value = rawValue as string
          type = 'fontFamily'
        } else if (variable.resolvedType === 'BOOLEAN') {
          continue
        } else {
          continue
        }

        const path = variable.name
          .replace(/\//g, '.')
          .toLowerCase()
          .replace(/\s+/g, '-')

        setNested(output, path, { $value: value, $type: type })
      }
    }

    figma.ui.postMessage({ type: 'tokens', data: output })
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

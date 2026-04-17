/** Matches server `FigmaRegistryComponent` in app/api/figma/plugin/export/export-helpers.ts */
export interface FigmaRegistryComponent {
  figmaNodeId: string
  name: string
  description?: string
  propertyDefinitions: {
    name: string
    type: string
    defaultValue?: unknown
    variantOptions?: string[]
  }[]
  variants: {
    figmaNodeId: string
    name: string
    props: Record<string, string>
  }[]
}

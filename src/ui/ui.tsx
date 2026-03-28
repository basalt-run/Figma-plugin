import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './ui.css'

type MergeStrategy = 'merge' | 'overwrite'
type Status = 'idle' | 'scanning' | 'loading' | 'success' | 'error'

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

declare global {
  interface Window {
    onmessage: ((event: MessageEvent) => void) | null
  }
}

const DEFAULT_ENDPOINT = 'https://basalt.run/api/figma/plugin/export'

function App() {
  const apiKeyRef = useRef<HTMLInputElement>(null)
  const repoRef = useRef<HTMLInputElement>(null)
  const filePathRef = useRef<HTMLInputElement>(null)
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('merge')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [showComponents, setShowComponents] = useState(false)
  const [showIcons, setShowIcons] = useState(false)
  const [endpointUrl, setEndpointUrl] = useState(DEFAULT_ENDPOINT)
  const [showSettings, setShowSettings] = useState(false)
  const [importFilterSummary, setImportFilterSummary] = useState<{
    excluded: { name: string; reason: string }[]
  } | null>(null)
  const [exportWarnings, setExportWarnings] = useState<string[]>([])
  const [exportHint, setExportHint] = useState<string | null>(null)
  const [filterCounts, setFilterCounts] = useState<{ raw: number; kept: number } | null>(null)
  const endpointUrlRef = useRef(endpointUrl)
  endpointUrlRef.current = endpointUrl

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        (el as HTMLInputElement).focus()
      }
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // Load prefs once on mount
  useEffect(() => {
    parent.postMessage({ pluginMessage: { type: 'load-prefs' } }, '*')
    parent.postMessage({ pluginMessage: { type: 'scan' } }, '*')
  }, [])

  // Message handler — stable listener, reads endpointUrl from ref
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const msg = (event.data as any).pluginMessage
      if (!msg) return

      if (msg.type === 'prefs') {
        if (apiKeyRef.current) apiKeyRef.current.value = msg.apiKey ?? ''
        if (repoRef.current) repoRef.current.value = msg.repo ?? ''
        if (filePathRef.current) filePathRef.current.value = msg.filePath ?? 'tokens/figma-import.json'
        if (msg.endpointUrl) setEndpointUrl(msg.endpointUrl)
      }

      if (msg.type === 'scan-result') {
        setScan(msg as ScanResult)
      }

      if (msg.type === 'export-error') {
        setStatus('error')
        setMessage(msg.error ?? 'Export failed')
        return
      }

      if (msg.type === 'do-export') {
        const {
          tokens, components, icons, shadows, typography, metadata,
          apiKey, repo, filePath, mergeStrategy: strategy, commitMessage,
        } = msg
        setStatus('loading')
        setMessage('Starting export…')
        setImportFilterSummary(null)
        setExportWarnings([])
        setExportHint(null)
        setFilterCounts(null)

        const payload = {
          tokens,
          components,
          icons,
          shadows,
          typography,
          metadata,
          repo,
          filePath,
          mergeStrategy: strategy,
          commitMessage,
          summary: {
            totalTokens: scan?.tokenCount ?? 0,
            totalComponents: components?.length ?? 0,
            totalVariants: components?.reduce((s: number, c: any) => s + (c.variants?.length ?? 0), 0) ?? 0,
            totalIcons: icons?.length ?? 0,
            generatedAt: metadata?.exportedAt,
          },
        }

        const applySuccessFromResult = (
          data: {
            imported?: { tokens?: number; components?: number; variants?: number; icons?: number; thumbnails?: number }
            figmaImportFilter?: {
              excluded?: { name: string; reason: string }[]
              rawCount?: number
              includedCount?: number
            }
            warnings?: string[]
            hint?: string
          },
          sentSummary?: { totalComponents?: number },
        ) => {
          setStatus('success')
          setExportWarnings(Array.isArray(data.warnings) ? data.warnings : [])
          setExportHint(typeof data.hint === 'string' && data.hint ? data.hint : null)
          const fi = data?.figmaImportFilter
          if (fi && typeof fi.rawCount === 'number') {
            setFilterCounts({ raw: fi.rawCount, kept: fi.includedCount ?? 0 })
          } else {
            setFilterCounts(null)
          }
          const excluded = data?.figmaImportFilter?.excluded
          if (excluded && excluded.length > 0) {
            setImportFilterSummary({ excluded })
          } else {
            setImportFilterSummary(null)
          }
          const imp = data?.imported
          if (imp) {
            const thumbs = imp.thumbnails ?? 0
            setMessage(
              `${imp.tokens ?? 0} tokens, ${imp.components ?? 0} components, ${imp.variants ?? 0} variants, ${imp.icons ?? 0} icons${thumbs > 0 ? `, ${thumbs} thumbnails` : ''} exported`,
            )
            const sentComp = sentSummary?.totalComponents ?? 0
            if (sentComp > 0 && (imp.components ?? 0) === 0) {
              setExportWarnings((w) => [
                `Figma sent ${sentComp} component(s) but the server saved 0. Open Vercel/runtime logs and search for [figma-export] and [figma-import].`,
                ...w,
              ])
            }
          } else {
            setMessage('Design system exported successfully')
          }
        }

        try {
          const exportUrl = endpointUrlRef.current.replace(/\/?$/, '')
          const res = await fetch(exportUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
          })
          const data = await res.json().catch(() => ({}))

          if (res.status === 202 && !data?.jobId) {
            setStatus('error')
            setMessage(typeof data?.error === 'string' ? data.error : 'Export started but no job id was returned.')
            return
          }

          if (res.status === 202 && data?.jobId) {
            const statusUrl = `${exportUrl.replace(/\/export\/?$/, '')}/export/status?jobId=${encodeURIComponent(data.jobId)}`
            setMessage('Exporting tokens to GitHub…')

            for (let attempt = 0; attempt < 60; attempt++) {
              await new Promise((r) => setTimeout(r, 5000))
              setMessage(`Exporting tokens to GitHub… (${attempt + 1}/60)`)

              const statusRes = await fetch(statusUrl, {
                headers: { Authorization: `Bearer ${apiKey}` },
              })
              const j = await statusRes.json().catch(() => ({}))

              if (!statusRes.ok) {
                setStatus('error')
                const raw = j?.error ?? j?.message
                setMessage(typeof raw === 'string' ? raw : `Status check failed (${statusRes.status})`)
                return
              }

              if (j.status === 'done') {
                if (j.result) {
                  applySuccessFromResult(j.result, payload.summary)
                } else {
                  setStatus('success')
                  setMessage('Design system exported successfully')
                }
                return
              }
              if (j.status === 'error') {
                setStatus('error')
                const errText = typeof j.error === 'string' ? j.error : 'Export failed'
                if (errText.includes('Not Found') || errText.includes('repo')) {
                  setMessage(`Repo not found. Create "${repo}" on GitHub first, then export again.`)
                } else {
                  setMessage(errText)
                }
                return
              }
            }

            setStatus('error')
            setMessage('Export is taking longer than expected. Check the Basalt dashboard.')
            return
          }

          if (res.ok && (data?.success || data?.imported)) {
            applySuccessFromResult(data, payload.summary)
            return
          }

          if (res.ok) {
            setStatus('error')
            setMessage(typeof data?.error === 'string' ? data.error : 'Unexpected response from export server.')
            return
          }

          if (!res.ok) {
            setStatus('error')
            const raw = data?.error ?? data?.message
            const errMsg = typeof raw === 'string' ? raw : raw != null ? JSON.stringify(raw) : `Export failed (${res.status})`
            if (res.status === 500 && errMsg.includes('Not Found')) {
              setMessage(`Repo not found. Create "${repo}" on GitHub first, then export again.`)
            } else {
              setMessage(errMsg)
            }
          }
        } catch (err) {
          setStatus('error')
          setMessage(err instanceof Error ? err.message : 'Failed to fetch')
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [scan?.tokenCount])

  const handleExport = () => {
    const key = apiKeyRef.current?.value ?? ''
    const repo = repoRef.current?.value ?? ''
    const path = filePathRef.current?.value ?? ''
    if (!key || !repo || !path) return
    setStatus('loading')
    setMessage('')
    parent.postMessage({ pluginMessage: { type: 'save-prefs', apiKey: key, repo, filePath: path, endpointUrl } }, '*')
    parent.postMessage({
      pluginMessage: {
        type: 'export',
        apiKey: key,
        repo,
        filePath: path,
        mergeStrategy,
      },
    }, '*')
  }

  const handleRescan = () => {
    setScan(null)
    parent.postMessage({ pluginMessage: { type: 'scan' } }, '*')
  }

  const totalItems = (scan?.tokenCount ?? 0) + (scan?.componentCount ?? 0) + (scan?.iconCount ?? 0)

  return (
    <div className="app-root">
      <div className="app-header">
        <div className="app-icon" />
        <div>
          <h2>Basalt</h2>
          <p>Export design system to Git</p>
        </div>
      </div>

      {/* Analysis section */}
      {scan ? (
        <div className="analysis-section">
          <div className="analysis-header">
            <span className="analysis-title">Analysis</span>
            <button type="button" className="rescan-button" onClick={handleRescan}>
              Rescan
            </button>
          </div>

          <div className="analysis-grid">
            <div className="analysis-item">
              <span className="analysis-count">{scan.tokenCount}</span>
              <span className="analysis-label">Tokens</span>
              <span className="analysis-detail">{scan.colorCount} color, {scan.dimensionCount} dimension</span>
            </div>
            <div className="analysis-item">
              <span className="analysis-count">{scan.componentCount}</span>
              <span className="analysis-label">Components</span>
              <span className="analysis-detail">{scan.variantCount} variants</span>
            </div>
            <div className="analysis-item">
              <span className="analysis-count">{scan.iconCount}</span>
              <span className="analysis-label">Icons</span>
            </div>
            <div className="analysis-item">
              <span className="analysis-count">{scan.shadowCount + scan.typographyCount}</span>
              <span className="analysis-label">Styles</span>
              <span className="analysis-detail">{scan.shadowCount} shadow, {scan.typographyCount} type</span>
            </div>
          </div>

          {scan.components.length > 0 && (
            <div className="analysis-list">
              <button
                type="button"
                className="analysis-list-toggle"
                onClick={() => setShowComponents(!showComponents)}
              >
                {showComponents ? '▾' : '▸'} Components ({scan.components.length})
              </button>
              {showComponents && (
                <ul className="analysis-list-items">
                  {scan.components.map((c) => (
                    <li key={c.name}>
                      {c.name} <span className="muted">({c.variantCount} variants)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {scan.icons.length > 0 && (
            <div className="analysis-list">
              <button
                type="button"
                className="analysis-list-toggle"
                onClick={() => setShowIcons(!showIcons)}
              >
                {showIcons ? '▾' : '▸'} Icons ({scan.icons.length})
              </button>
              {showIcons && (
                <ul className="analysis-list-items">
                  {scan.icons.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="analysis-section">
          <p className="muted" style={{ textAlign: 'center', fontSize: 11, margin: '12px 0' }}>
            Scanning document...
          </p>
        </div>
      )}

      {/* Settings */}
      <label className="field-label">Basalt API Key</label>
      <input
        ref={apiKeyRef}
        type="password"
        defaultValue=""
        placeholder="bsk_..."
        className="field-input"
        tabIndex={1}
        onFocus={(e) => e.target.select()}
      />

      <label className="field-label">GitHub Repo</label>
      <input
        ref={repoRef}
        type="text"
        defaultValue=""
        placeholder="owner/repo"
        className="field-input"
        tabIndex={2}
        onFocus={(e) => e.target.select()}
      />

      <label className="field-label">Token File Path</label>
      <input
        ref={filePathRef}
        type="text"
        defaultValue="tokens/figma-import.json"
        placeholder="tokens/figma-import.json"
        className="field-input"
        tabIndex={3}
        onFocus={(e) => e.target.select()}
      />

      <label className="field-label">Import Mode</label>
      <div className="toggle-group">
        {(['merge', 'overwrite'] as MergeStrategy[]).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setMergeStrategy(opt)}
            title={
              opt === 'overwrite'
                ? 'Replaces all tokens in Basalt with the current Figma file. Use after renaming or restructuring variables to clear stale rows.'
                : 'Merges with existing tokens and GitHub file.'
            }
            className={
              'toggle-button' + (mergeStrategy === opt ? ' toggle-button--active' : '')
            }
          >
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>
      <p className="field-hint" style={{ marginTop: 6 }}>
        <strong>Overwrite</strong> replaces all tokens in Basalt with the current file. Use it to clean up
        after renaming or restructuring Figma variables (removes stale rows in one export).
      </p>

      {/* Advanced settings */}
      <div className="settings-section">
        <button
          type="button"
          className="settings-toggle"
          onClick={() => setShowSettings(!showSettings)}
        >
          {showSettings ? '▾' : '▸'} Advanced
          {endpointUrl !== DEFAULT_ENDPOINT && (
            <span className="settings-badge">custom endpoint</span>
          )}
        </button>
        {showSettings && (
          <div className="settings-body">
            <label className="field-label" style={{ marginTop: 6 }}>Basalt Endpoint URL</label>
            <input
              type="text"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              onBlur={() => {
                parent.postMessage({
                  pluginMessage: { type: 'save-prefs', apiKey: apiKeyRef.current?.value, repo: repoRef.current?.value, filePath: filePathRef.current?.value, endpointUrl },
                }, '*')
              }}
              placeholder={DEFAULT_ENDPOINT}
              className="field-input"
              tabIndex={4}
              onFocus={(e) => e.target.select()}
            />
            <p className="field-hint">
              Default: basalt.run. For local dev use your dev origin + <code>/api/figma/plugin/export</code> (e.g.{' '}
              <code>http://localhost:3000/...</code> or <code>http://ja-air.local:3000/...</code>).
            </p>
            {endpointUrl !== DEFAULT_ENDPOINT && (
              <button
                type="button"
                className="rescan-button"
                style={{ marginTop: 6 }}
                onClick={() => {
                  setEndpointUrl(DEFAULT_ENDPOINT)
                  parent.postMessage({
                    pluginMessage: { type: 'save-prefs', apiKey: apiKeyRef.current?.value, repo: repoRef.current?.value, filePath: filePathRef.current?.value, endpointUrl: DEFAULT_ENDPOINT },
                  }, '*')
                }}
              >
                Reset to production
              </button>
            )}
          </div>
        )}
      </div>

      {/* Endpoint indicator */}
      <div className="endpoint-indicator">
        {endpointUrl === DEFAULT_ENDPOINT ? (
          <span className="endpoint-dot endpoint-dot--prod" />
        ) : (
          <span className="endpoint-dot endpoint-dot--custom" />
        )}
        <span className="endpoint-label">
          {endpointUrl === DEFAULT_ENDPOINT ? 'basalt.run' : endpointUrl.replace(/^https?:\/\//, '').split('/')[0]}
        </span>
      </div>

      {status === 'loading' && (
        <div className="export-progress" role="status">
          <span className="export-spinner" aria-hidden />
          <span className="export-progress-text">{message || 'Exporting…'}</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleExport}
        disabled={status === 'loading' || totalItems === 0}
        className="primary-button"
      >
        {status === 'loading' ? 'Exporting...' : `Export to Basalt (${totalItems} items)`}
      </button>

      {status === 'success' && (
        <div className="status status--success">
          <p>
            <span>&#10003;</span> {message}
          </p>
          {filterCounts && (
            <p className="muted" style={{ marginTop: 6, fontSize: 11, textAlign: 'left', opacity: 0.9 }}>
              Server filter: {filterCounts.kept} of {filterCounts.raw} Figma components kept for import
            </p>
          )}
          {exportHint && (
            <p style={{ marginTop: 6, fontSize: 11, textAlign: 'left', opacity: 0.9 }}>{exportHint}</p>
          )}
          {exportWarnings.length > 0 && (
            <details style={{ marginTop: 8, textAlign: 'left', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', opacity: 0.85 }}>Server warnings ({exportWarnings.length})</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 16, maxHeight: 140, overflowY: 'auto', opacity: 0.9 }}>
                {exportWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          {importFilterSummary && importFilterSummary.excluded.length > 0 && (
            <details style={{ marginTop: 8, textAlign: 'left', fontSize: 11 }}>
              <summary style={{ cursor: 'pointer', opacity: 0.85 }}>
                {importFilterSummary.excluded.length} internal elements filtered out
              </summary>
              <ul
                style={{
                  margin: '6px 0 0',
                  paddingLeft: 16,
                  maxHeight: 160,
                  overflowY: 'auto',
                  opacity: 0.9,
                }}
              >
                {importFilterSummary.excluded.map((row, i) => (
                  <li key={`${i}-${row.name}`}>
                    {row.name} — {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {status === 'error' && (
        <p className="status status--error">
          <span>&#10007;</span>{' '}
          {typeof message === 'string' ? message : JSON.stringify(message)}
        </p>
      )}
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
root.render(<App />)

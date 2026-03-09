import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import './ui.css'

type MergeStrategy = 'merge' | 'overwrite'

type Status = 'idle' | 'loading' | 'success' | 'error'

declare global {
  interface Window {
    onmessage: ((event: MessageEvent) => void) | null
  }
}

function App() {
  const [apiKey, setApiKey] = useState('')
  const [repo, setRepo] = useState('')
  const [filePath, setFilePath] = useState('tokens/figma-import.json')
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('merge')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

  useEffect(() => {
    parent.postMessage({ pluginMessage: { type: 'load-prefs' } }, '*')

    window.onmessage = async (event: MessageEvent) => {
      const msg = (event.data as any).pluginMessage
      if (!msg) return

      if (msg.type === 'prefs') {
        if (msg.apiKey) setApiKey(msg.apiKey)
        if (msg.repo) setRepo(msg.repo)
        if (msg.filePath) setFilePath(msg.filePath)
      }

      if (msg.type === 'tokens') {
        try {
          const res = await fetch('https://www.basalt.run/api/figma/plugin-import', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              tokens: msg.data,
              repo,
              filePath,
              mergeStrategy,
              commitMessage: 'feat(tokens): import from Figma plugin',
            }),
          })

          if (!res.ok) {
            const err = await res.json().catch(() => ({}))
            throw new Error(err.message ?? 'Import failed')
          }

          const result = await res.json().catch(() => ({}))
          setStatus('success')
          if (result?.tokenCount != null) {
            setMessage(`${result.tokenCount} tokens written to ${repo}/${filePath}`)
          } else {
            setMessage(`Tokens written to ${repo}/${filePath}`)
          }
        } catch (err: any) {
          setStatus('error')
          setMessage(err?.message ?? 'Something went wrong')
        }
      }
    }
  }, [apiKey, repo, filePath, mergeStrategy])

  const handleExport = () => {
    if (!apiKey || !repo || !filePath) return
    setStatus('loading')
    setMessage('')
    parent.postMessage({ pluginMessage: { type: 'save-prefs', apiKey, repo, filePath } }, '*')
    parent.postMessage({ pluginMessage: { type: 'export' } }, '*')
  }

  return (
    <div className="app-root">
      <div className="app-header">
        <div className="app-icon" />
        <div>
          <h2>Basalt</h2>
          <p>Export variables to your design system repo</p>
        </div>
      </div>

      <label className="field-label">Basalt API Key</label>
      <input
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="bsk_..."
        className="field-input"
      />

      <label className="field-label">GitHub Repo</label>
      <input
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        placeholder="owner/repo"
        className="field-input"
      />

      <label className="field-label">File Path</label>
      <input
        value={filePath}
        onChange={(e) => setFilePath(e.target.value)}
        placeholder="tokens/figma-import.json"
        className="field-input"
      />

      <label className="field-label">Import Mode</label>
      <div className="toggle-group">
        {(['merge', 'overwrite'] as MergeStrategy[]).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setMergeStrategy(opt)}
            className={
              'toggle-button' + (mergeStrategy === opt ? ' toggle-button--active' : '')
            }
          >
            {opt.charAt(0).toUpperCase() + opt.slice(1)}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={handleExport}
        disabled={!apiKey || !repo || !filePath || status === 'loading'}
        className="primary-button"
      >
        {status === 'loading' ? 'Exporting…' : 'Export tokens'}
      </button>

      {status === 'success' && (
        <p className="status status--success">
          <span>✓</span> {message}
        </p>
      )}
      {status === 'error' && (
        <p className="status status--error">
          <span>✗</span> {message}
        </p>
      )}
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
root.render(<App />)

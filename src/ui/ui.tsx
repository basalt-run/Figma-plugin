import React, { useEffect, useRef, useState } from 'react'
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
  const apiKeyRef = useRef<HTMLInputElement>(null)
  const repoRef = useRef<HTMLInputElement>(null)
  const filePathRef = useRef<HTMLInputElement>(null)
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('merge')
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('')

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

  useEffect(() => {
    parent.postMessage({ pluginMessage: { type: 'load-prefs' } }, '*')

    const handleMessage = async (event: MessageEvent) => {
      const msg = (event.data as any).pluginMessage
      if (!msg) return

      if (msg.type === 'prefs') {
        if (apiKeyRef.current) apiKeyRef.current.value = msg.apiKey ?? ''
        if (repoRef.current) repoRef.current.value = msg.repo ?? ''
        if (filePathRef.current) filePathRef.current.value = msg.filePath ?? 'tokens/figma-import.json'
      }

      if (msg.type === 'do-export') {
        const { tokens, apiKey, repo, filePath, mergeStrategy: strategy, commitMessage } = msg
        setStatus('loading')
        try {
          const res = await fetch('https://basalt.run/api/figma/plugin-import', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ tokens, repo, filePath, mergeStrategy: strategy, commitMessage }),
          })
          const data = await res.json().catch(() => ({}))
          if (res.ok) {
            setStatus('success')
            if (data?.tokenCount != null) {
              setMessage(`${data.tokenCount} tokens written to ${repo}/${filePath}`)
            } else {
              setMessage(`Tokens written to ${repo}/${filePath}`)
            }
          } else {
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
  }, [])

  const handleExport = () => {
    const key = apiKeyRef.current?.value ?? ''
    const repo = repoRef.current?.value ?? ''
    const path = filePathRef.current?.value ?? ''
    if (!key || !repo || !path) return
    setStatus('loading')
    setMessage('')
    parent.postMessage({ pluginMessage: { type: 'save-prefs', apiKey: key, repo, filePath: path } }, '*')
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
      <p className="field-hint">Must be an existing GitHub repo in owner/repo format.</p>

      <label className="field-label">File Path</label>
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
        disabled={status === 'loading'}
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
          <span>✗</span>{' '}
          {typeof message === 'string' ? message : JSON.stringify(message)}
        </p>
      )}
    </div>
  )
}

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)
root.render(<App />)

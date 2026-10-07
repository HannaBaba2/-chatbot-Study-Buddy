import { useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react'
import Markdown from 'react-markdown'
import type { Role } from '../api'

export interface ChatMessage {
  role: Role
  content: string
}

interface ChatWindowProps {
  messages: ChatMessage[]
  loading: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  models: string[]
  model: string
  onModelChange: (value: string) => void
  noteMode: boolean
  onNoteModeChange: (value: boolean) => void
}

export default function ChatWindow({
  messages,
  loading,
  draft,
  onDraftChange,
  onSend,
  onStop,
  models,
  model,
  onModelChange,
  noteMode,
  onNoteModeChange,
}: ChatWindowProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Keep the latest message in view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!loading && draft.trim()) onSend()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter inserts a new line.
    if (event.key === 'Enter' && !event.shiftKey) handleSubmit(event)
  }

  const lastIndex = messages.length - 1

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && !loading && (
          <p className="muted center">Pose ta première question à Study Buddy.</p>
        )}
        {messages.map((m, i) => {
          if (m.role === 'system-notification') {
            return (
              <div key={i} className="notification">
                {m.content}
              </div>
            )
          }
          if (m.role === 'note') {
            // Custom role: personal note, shown with its own style and never sent to the LLM.
            return (
              <div key={i} className="note">
                <span className="note-label">Note personnelle</span>
                {m.content}
              </div>
            )
          }
          const waiting = loading && i === lastIndex && m.role === 'assistant' && m.content === ''
          return (
            <div key={i} className={`bubble ${m.role}${waiting ? ' typing' : ''}`}>
              {/* The LLM answers in Markdown; user messages are shown as typed. */}
              {waiting ? '…' : m.role === 'assistant' ? <Markdown>{m.content}</Markdown> : m.content}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="composer-options">
        <label>
          Modèle{' '}
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={loading || noteMode || models.length === 0}
          >
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={noteMode}
            onChange={(e) => onNoteModeChange(e.target.checked)}
            disabled={loading}
          />{' '}
          Note personnelle (non envoyée à l'IA)
        </label>
      </div>
      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={noteMode ? 'Écris une note pour toi…' : 'Écris ton message…'}
          rows={2}
          disabled={loading}
          autoFocus
        />
        {loading ? (
          <button type="button" className="stop" onClick={onStop}>
            Arrêter
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            {noteMode ? 'Ajouter la note' : 'Envoyer'}
          </button>
        )}
      </form>
    </section>
  )
}

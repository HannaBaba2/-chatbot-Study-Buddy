import { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  addNote,
  createConversation,
  getMessages,
  getModels,
  listConversations,
  streamMessage,
  type ConversationSummary,
} from './api'
import ChatWindow, { type ChatMessage } from './components/ChatWindow'
import Sidebar from './components/Sidebar'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Une erreur est survenue.'
}

export default function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [noteMode, setNoteMode] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Models allowed by the backend (the list is defined server-side).
  useEffect(() => {
    getModels()
      .then((info) => {
        setModels(info.models)
        setModel(info.default)
      })
      .catch((err) => setError(errorMessage(err)))
  }, [])

  // On startup, load the history and open the most recent conversation.
  useEffect(() => {
    listConversations()
      .then((list) => {
        setConversations(list)
        if (list.length > 0) setActiveId(list[0].id)
      })
      .catch((err) => setError(errorMessage(err)))
  }, [])

  // Load the messages whenever another conversation is opened.
  useEffect(() => {
    if (activeId === null) return
    let cancelled = false
    getMessages(activeId)
      .then((list) => {
        if (!cancelled) setMessages(list.map(({ role, content }) => ({ role, content })))
      })
      .catch((err) => !cancelled && setError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [activeId])

  function selectConversation(id: number) {
    if (loading || id === activeId) return
    setError(null)
    setDraft('')
    setMessages([])
    setActiveId(id)
  }

  async function handleNew() {
    if (loading) return
    setError(null)
    try {
      const id = await createConversation()
      setConversations((list) => [
        { id, created_at: new Date().toISOString(), preview: null },
        ...list,
      ])
      setDraft('')
      setMessages([])
      setActiveId(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function handleAddNote(text: string) {
    if (activeId === null) return
    const isFirstMessage = messages.length === 0
    try {
      const note = await addNote(activeId, text)
      setMessages((list) => [...list, { role: 'note', content: note.content }])
      if (isFirstMessage) setConversations(await listConversations())
    } catch (err) {
      setDraft(text)
      setError(errorMessage(err))
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleSend() {
    if (activeId === null) return
    const text = draft.trim()
    if (!text) return
    setError(null)
    setDraft('')
    if (noteMode) {
      await handleAddNote(text)
      return
    }
    const isFirstMessage = messages.length === 0
    const controller = new AbortController()
    abortRef.current = controller
    // Optimistic display: the user's message, then an empty assistant bubble filled as the stream arrives.
    setMessages((list) => [
      ...list,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ])
    setLoading(true)
    try {
      const { notification } = await streamMessage(
        activeId,
        text,
        model,
        (chunk) =>
          setMessages((list) => {
            const last = list[list.length - 1]
            return [...list.slice(0, -1), { ...last, content: last.content + chunk }]
          }),
        controller.signal,
      )
      if (notification) {
        setMessages((list) => [...list, { role: 'system-notification', content: notification }])
      }
      // The first message becomes the conversation's preview in the sidebar.
      if (isFirstMessage) setConversations(await listConversations())
    } catch (err) {
      // The backend saves the turn only once the stream is complete: drop both optimistic
      // messages and give the text back so the user can resend.
      setMessages((list) => list.slice(0, -2))
      setDraft(text)
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Génération arrêtée : rien n’a été enregistré.')
      } else {
        setError(errorMessage(err))
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  return (
    <div className="app">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={handleNew}
      />
      <main className="main">
        {error && (
          <div className="error" role="alert">
            {error}
            <button onClick={() => setError(null)} aria-label="Fermer">
              ×
            </button>
          </div>
        )}
        {activeId === null ? (
          <div className="empty">
            <p>Aucune conversation ouverte.</p>
            <button className="new-button" onClick={handleNew}>
              + Nouvelle conversation
            </button>
          </div>
        ) : (
          <ChatWindow
            messages={messages}
            loading={loading}
            draft={draft}
            onDraftChange={setDraft}
            onSend={handleSend}
            onStop={handleStop}
            models={models}
            model={model}
            onModelChange={setModel}
            noteMode={noteMode}
            onNoteModeChange={setNoteMode}
          />
        )}
      </main>
    </div>
  )
}

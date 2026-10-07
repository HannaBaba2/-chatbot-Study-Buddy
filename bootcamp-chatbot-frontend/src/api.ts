// Thin typed wrappers around the FastAPI backend (proxied under /api by Vite).

export type Role = 'user' | 'assistant' | 'system-notification' | 'note'

export interface ConversationSummary {
  id: number
  created_at: string
  preview: string | null
}

export interface Message {
  seq: number
  role: Role
  content: string
  created_at: string
}

export interface ModelsInfo {
  models: string[]
  default: string
}

async function errorFrom(response: Response): Promise<Error> {
  // FastAPI errors look like {"detail": "..."}.
  const body = await response.json().catch(() => null)
  const detail = typeof body?.detail === 'string' ? body.detail : null
  return new Error(detail ?? `Erreur ${response.status}`)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new Error('Impossible de joindre le serveur.')
  }
  if (!response.ok) throw await errorFrom(response)
  return response.json() as Promise<T>
}

export function listConversations(): Promise<ConversationSummary[]> {
  return request('/conversations')
}

export async function createConversation(): Promise<number> {
  const { conversation_id } = await request<{ conversation_id: number }>('/conversations', {
    method: 'POST',
  })
  return conversation_id
}

export function getMessages(conversationId: number): Promise<Message[]> {
  return request(`/conversations/${conversationId}/messages`)
}

// Models the backend allows (the list lives on the server, never trust the client).
export function getModels(): Promise<ModelsInfo> {
  return request('/models')
}

// Custom role "note": stored and displayed, but never sent to the LLM.
export function addNote(conversationId: number, content: string): Promise<Message> {
  return request(`/conversations/${conversationId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

export interface ChatResult {
  notification: string | null // set when the backend also stored a system-notification
}

type StreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; notification: string | null; model: string }
  | { type: 'error'; detail: string }

// Sends a message and reads the answer as it is generated (Server-Sent Events over a POST:
// EventSource cannot POST, so we read the body with fetch + getReader()).
export async function streamMessage(
  conversationId: number,
  message: string,
  model: string,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  let response: Response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId, message, model }),
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new Error('Impossible de joindre le serveur.')
  }
  if (!response.ok) throw await errorFrom(response)
  if (!response.body) throw new Error('Réponse sans flux.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Events are separated by a blank line.
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5).trim()) as StreamEvent
        if (event.type === 'delta') onDelta(event.content)
        else if (event.type === 'error') throw new Error(event.detail)
        else if (event.type === 'done') return { notification: event.notification }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  throw new Error('Le flux a été interrompu avant la fin.')
}

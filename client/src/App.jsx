import { useState, useEffect, useRef } from 'react'
import { socket } from './socket'
import Home         from './components/Home'
import LobbyWaiting from './components/LobbyWaiting'
import StoryRoom    from './components/StoryRoom'

export default function App() {
  const [view,            setView]           = useState('home')
  const [lobby,           setLobby]          = useState(null)
  const [socketId,        setSocketId]        = useState(null)
  const [toast,           setToast]           = useState(null)
  const [generatingScene, setGeneratingScene] = useState(false)

  // Persists across reconnects — stores { code, name } so we can auto-rejoin
  const sessionRef = useRef(
    (() => {
      try { return JSON.parse(sessionStorage.getItem('tw_session')) } catch { return null }
    })()
  )

  const saveSession = (code, name) => {
    sessionRef.current = { code, name }
    try { sessionStorage.setItem('tw_session', JSON.stringify({ code, name })) } catch {}
  }

  const clearSession = () => {
    sessionRef.current = null
    try { sessionStorage.removeItem('tw_session') } catch {}
  }

  const showToast = (msg, kind = 'error') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    // ── CONNECTION ────────────────────────────
    socket.on('connect', () => {
      setSocketId(socket.id)
      // Auto-rejoin if we have a saved session (handles reconnects transparently)
      const s = sessionRef.current
      if (s?.code && s?.name) {
        socket.emit('rejoin-session', { code: s.code, name: s.name })
      }
    })

    socket.on('disconnect', () => {
      // Don't clear anything — socket will reconnect automatically
      // and the connect handler above will re-send rejoin-session
    })

    // ── LOBBY EVENTS ──────────────────────────
    socket.on('lobby-created', (data) => {
      const me = data.players.find(p => p.id === socket.id)
      if (me) saveSession(data.code, me.name)
      setLobby(data)
      setView('waiting')
    })

    socket.on('lobby-joined', (data) => {
      const me = data.players.find(p => p.id === socket.id)
      if (me) saveSession(data.code, me.name)
      setLobby(data)
      setView(data.status === 'playing' ? 'story' : 'waiting')
    })

    socket.on('lobby-updated', (data) => setLobby(data))
    socket.on('player-joined', (data) => setLobby(data))

    // ── GAME EVENTS ───────────────────────────
    socket.on('generating-scene', (data) => {
      setLobby(data); setView('story'); setGeneratingScene(true)
    })

    socket.on('game-started', (data) => {
      setLobby(data); setView('story'); setGeneratingScene(false)
    })

    socket.on('story-updated', (data) => setLobby(data))

    socket.on('turn-skipped', (data) => {
      setLobby(data)
      if (data.notice) showToast(data.notice, 'info')
    })

    socket.on('vote-started',  (data) => {
      setLobby(data)
      if (data.notice) showToast(data.notice, 'info')
    })
    socket.on('vote-updated',  (data) => setLobby(data))
    socket.on('vote-resolved', (data) => {
      setLobby(data)
      if (data.notice) showToast(data.notice, data.kicked ? 'success' : 'info')
    })

    socket.on('player-left', (data) => {
      setLobby(data)
      if (data.notice) showToast(data.notice, 'info')
    })

    socket.on('you-were-kicked', ({ message }) => {
      clearSession()
      setView('home'); setLobby(null)
      showToast(message, 'error')
    })

    socket.on('err', (msg) => showToast(msg, 'error'))

    return () => {
      ['connect','disconnect','lobby-created','lobby-joined','lobby-updated',
       'player-joined','generating-scene','game-started','story-updated',
       'turn-skipped','vote-started','vote-updated','vote-resolved',
       'player-left','you-were-kicked','err'].forEach(e => socket.off(e))
    }
  }, [])

  return (
    <>
      {toast && (
        <div className="toast-wrap">
          <div className={`toast ${toast.kind === 'error' ? '' : 'success'}`}>{toast.msg}</div>
        </div>
      )}
      {view === 'home'    && <Home />}
      {view === 'waiting' && lobby && <LobbyWaiting lobby={lobby} socketId={socketId} />}
      {view === 'story'   && lobby && (
        <StoryRoom lobby={lobby} socketId={socketId} generatingScene={generatingScene} />
      )}
    </>
  )
}

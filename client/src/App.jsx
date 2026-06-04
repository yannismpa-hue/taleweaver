import { useState, useEffect } from 'react'
import { socket } from './socket'
import Home         from './components/Home'
import LobbyWaiting from './components/LobbyWaiting'
import StoryRoom    from './components/StoryRoom'

export default function App() {
  const [view,           setView]          = useState('home')
  const [lobby,          setLobby]         = useState(null)
  const [socketId,       setSocketId]      = useState(null)
  const [toast,          setToast]         = useState(null)
  const [generatingScene,setGeneratingScene] = useState(false)

  const showToast = (msg, kind = 'error') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 4000)
  }

  useEffect(() => {
    socket.on('connect', () => setSocketId(socket.id))

    socket.on('lobby-created', (data) => { setLobby(data); setView('waiting') })
    socket.on('lobby-joined',  (data) => {
      setLobby(data)
      setView(data.status === 'playing' ? 'story' : 'waiting')
    })
    socket.on('lobby-updated', (data) => setLobby(data))
    socket.on('player-joined', (data) => setLobby(data))

    socket.on('generating-scene', (data) => {
      setLobby(data)
      setView('story')
      setGeneratingScene(true)
    })

    socket.on('game-started', (data) => {
      setLobby(data)
      setView('story')
      setGeneratingScene(false)
    })

    socket.on('story-updated',  (data) => setLobby(data))
    socket.on('turn-skipped',   (data) => {
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
      setView('home')
      setLobby(null)
      showToast(message, 'error')
    })

    socket.on('err', (msg) => showToast(msg, 'error'))

    return () => {
      ['connect','lobby-created','lobby-joined','lobby-updated','player-joined',
       'generating-scene','game-started','story-updated','turn-skipped',
       'vote-started','vote-updated','vote-resolved','player-left',
       'you-were-kicked','err'].forEach(e => socket.off(e))
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
      {view === 'story'   && lobby && <StoryRoom lobby={lobby} socketId={socketId} generatingScene={generatingScene} />}
    </>
  )
}

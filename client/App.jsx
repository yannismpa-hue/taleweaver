import { useState, useEffect } from 'react'
import { socket } from './socket'
import Home        from './components/Home'
import LobbyWaiting from './components/LobbyWaiting'
import StoryRoom   from './components/StoryRoom'

export default function App() {
  const [view,    setView]    = useState('home')     // 'home' | 'waiting' | 'story'
  const [lobby,   setLobby]   = useState(null)
  const [socketId, setSocketId] = useState(null)
  const [toast,   setToast]   = useState(null)       // { msg, kind }

  const showToast = (msg, kind = 'error') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    socket.on('connect', () => setSocketId(socket.id))

    socket.on('lobby-created', (data) => { setLobby(data); setView('waiting') })
    socket.on('lobby-joined',  (data) => { setLobby(data); setView('waiting') })
    socket.on('lobby-updated', (data) => setLobby(data))
    socket.on('player-joined', (data) => setLobby(data))

    socket.on('game-started',  (data) => { setLobby(data); setView('story') })
    socket.on('story-updated', (data) => setLobby(data))

    socket.on('player-left', (data) => {
      setLobby(data)
      if (data.notice) showToast(data.notice, 'info')
    })

    socket.on('err', (msg) => showToast(msg, 'error'))

    return () => {
      socket.off('connect')
      socket.off('lobby-created');  socket.off('lobby-joined')
      socket.off('lobby-updated');  socket.off('player-joined')
      socket.off('game-started');   socket.off('story-updated')
      socket.off('player-left');    socket.off('err')
    }
  }, [])

  return (
    <>
      {toast && (
        <div className="toast-wrap">
          <div className={`toast ${toast.kind === 'error' ? '' : 'success'}`}>
            {toast.msg}
          </div>
        </div>
      )}

      {view === 'home'    && <Home />}
      {view === 'waiting' && lobby && (
        <LobbyWaiting lobby={lobby} socketId={socketId} />
      )}
      {view === 'story' && lobby && (
        <StoryRoom lobby={lobby} socketId={socketId} />
      )}
    </>
  )
}

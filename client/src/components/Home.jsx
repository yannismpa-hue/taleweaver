import { useState } from 'react'
import { socket } from '../socket'
import './Home.css'

export default function Home() {
  const [tab,        setTab]        = useState('create')  // 'create' | 'join'
  const [name,       setName]       = useState('')
  const [wordLimit,  setWordLimit]  = useState(20)
  const [joinCode,   setJoinCode]   = useState('')
  const [joinName,   setJoinName]   = useState('')
  const [loading,    setLoading]    = useState(false)

  const handleCreate = () => {
    if (!name.trim()) return
    setLoading(true)
    socket.emit('create-lobby', { playerName: name.trim(), wordLimit })
    setTimeout(() => setLoading(false), 4000)
  }

  const handleJoin = () => {
    if (!joinCode.trim() || !joinName.trim()) return
    setLoading(true)
    socket.emit('join-lobby', { code: joinCode.trim().toUpperCase(), playerName: joinName.trim() })
    setTimeout(() => setLoading(false), 4000)
  }

  return (
    <div className="home">
      <div className="stars-bg" />

      <div className="home-center">
        {/* ── TITLE ── */}
        <header className="home-header">
          <div className="home-rune">✦</div>
          <h1 className="home-title">TaleWeaver</h1>
          <p className="home-subtitle">Collaborative Storytelling for the Bold</p>
          <div className="home-divider">
            <span className="home-divider-line" />
            <span className="home-divider-ornament">❧</span>
            <span className="home-divider-line" />
          </div>
        </header>

        {/* ── CARD ── */}
        <div className="home-card">
          <div className="tab-bar">
            <button
              className={`tab-btn ${tab === 'create' ? 'active' : ''}`}
              onClick={() => setTab('create')}
            >
              ✦ Begin a Tale
            </button>
            <button
              className={`tab-btn ${tab === 'join' ? 'active' : ''}`}
              onClick={() => setTab('join')}
            >
              ✦ Join a Tale
            </button>
          </div>

          {tab === 'create' && (
            <div className="form-body">
              <label className="form-label">Your Scribe Name</label>
              <input
                className="form-input"
                type="text"
                maxLength={24}
                placeholder="Arcane Quill, the Storyteller…"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
              />

              <label className="form-label">
                Word Limit Per Turn
                <span className="form-label-hint">(5–100 words)</span>
              </label>
              <div className="slider-row">
                <input
                  type="range" min={5} max={100} step={5}
                  value={wordLimit}
                  onChange={e => setWordLimit(Number(e.target.value))}
                  className="form-slider"
                />
                <span className="slider-val">{wordLimit}</span>
              </div>

              <div className="form-hint">
                A new scene painting appears every 6 turns, conjured from your story.
              </div>

              <button
                className="btn-primary form-submit"
                onClick={handleCreate}
                disabled={!name.trim() || loading}
              >
                {loading ? 'Summoning lobby…' : '📜 Create Lobby'}
              </button>
            </div>
          )}

          {tab === 'join' && (
            <div className="form-body">
              <label className="form-label">Lobby Code</label>
              <input
                className="form-input code-input"
                type="text"
                maxLength={6}
                placeholder="ABCD12"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
              />

              <label className="form-label">Your Scribe Name</label>
              <input
                className="form-input"
                type="text"
                maxLength={24}
                placeholder="Night Ink, the Wanderer…"
                value={joinName}
                onChange={e => setJoinName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleJoin()}
              />

              <button
                className="btn-primary form-submit"
                onClick={handleJoin}
                disabled={!joinCode.trim() || !joinName.trim() || loading}
              >
                {loading ? 'Entering lobby…' : '🗝 Join Lobby'}
              </button>
            </div>
          )}
        </div>

        {/* ── HOW TO PLAY ── */}
        <div className="how-to">
          <span className="how-icon">👥</span> Up to 4 scribes &nbsp;·&nbsp;
          <span className="how-icon">✍️</span> Take turns writing &nbsp;·&nbsp;
          <span className="how-icon">🎨</span> AI paints every 6th turn
        </div>
      </div>
    </div>
  )
}

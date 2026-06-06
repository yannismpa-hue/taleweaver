import { useState } from 'react'
import { socket } from '../socket'
import './Home.css'

export default function Home() {
  const [tab,          setTab]         = useState('create')
  const [name,         setName]        = useState('')
  const [wordLimit,    setWordLimit]    = useState(20)
  const [imageEvery,   setImageEvery]   = useState(6)
  const [jokerCooldown,setJokerCooldown] = useState(30)
  const [randomScene,  setRandomScene]  = useState(false)
  const [hasAiPlayer,  setHasAiPlayer]  = useState(false)
  const [joinCode,     setJoinCode]     = useState('')
  const [joinName,     setJoinName]     = useState('')
  const [loading,      setLoading]      = useState(false)

  const handleCreate = () => {
    if (!name.trim()) return
    setLoading(true)
    socket.emit('create-lobby', {
      playerName: name.trim(), wordLimit, randomScene,
      hasAiPlayer, imageEvery, jokerCooldown,
    })
    setTimeout(() => setLoading(false), 6000)
  }

  const handleJoin = () => {
    if (!joinCode.trim() || !joinName.trim()) return
    setLoading(true)
    socket.emit('join-lobby', { code: joinCode.trim().toUpperCase(), playerName: joinName.trim() })
    setTimeout(() => setLoading(false), 6000)
  }

  const Toggle = ({ value, onChange, label, desc }) => (
    <div className="toggle-row" onClick={() => onChange(!value)}>
      <div className={`toggle-track ${value ? 'on' : ''}`}>
        <div className="toggle-thumb" />
      </div>
      <div className="toggle-info">
        <span className="toggle-title">{label}</span>
        <span className="toggle-desc">{desc}</span>
      </div>
    </div>
  )

  const Slider = ({ label, hint, value, onChange, min, max, step }) => (
    <>
      <label className="form-label">
        {label}
        <span className="form-label-hint">{hint}</span>
      </label>
      <div className="slider-row">
        <input type="range" min={min} max={max} step={step}
          value={value} onChange={e => onChange(Number(e.target.value))}
          className="form-slider" />
        <span className="slider-val">{value}</span>
      </div>
    </>
  )

  return (
    <div className="home">
      <div className="stars-bg" />
      <div className="home-center">

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

        <div className="home-card">
          <div className="tab-bar">
            <button className={`tab-btn ${tab==='create'?'active':''}`} onClick={() => setTab('create')}>✦ Begin a Tale</button>
            <button className={`tab-btn ${tab==='join'?'active':''}`}   onClick={() => setTab('join')}>✦ Join a Tale</button>
          </div>

          {tab === 'create' && (
            <div className="form-body">
              <label className="form-label">Your Scribe Name</label>
              <input className="form-input" type="text" maxLength={24}
                placeholder="Arcane Quill, the Storyteller…"
                value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()} />

              <div className="settings-divider">Story Settings</div>

              <Slider label="Word Limit Per Turn" hint="(5–100)"
                value={wordLimit} onChange={setWordLimit} min={5} max={100} step={5} />

              <Slider label="New Painting Every" hint="(2–20 turns)"
                value={imageEvery} onChange={setImageEvery} min={2} max={20} step={1} />

              <Slider label="Joker Recharge After" hint="(5–60 turns)"
                value={jokerCooldown} onChange={setJokerCooldown} min={5} max={60} step={5} />

              <div className="settings-divider">Mode</div>

              <Toggle
                value={randomScene} onChange={setRandomScene}
                label={randomScene ? '✦ Random Scene' : '📜 Set Your Own Scene'}
                desc={randomScene ? 'The Muse AI writes the opening' : 'First player gets 500 words to set the scene'}
              />

              <Toggle
                value={hasAiPlayer} onChange={setHasAiPlayer}
                label={hasAiPlayer ? '🤖 AI Player ON' : '🤖 AI Player OFF'}
                desc={hasAiPlayer ? 'The Oracle joins and takes turns' : 'Human players only'}
              />

              <div className="form-hint">
                A new scene painting appears every {imageEvery} turns.
                Joker recharges after {jokerCooldown} turns.
              </div>

              <button className="btn-primary form-submit" onClick={handleCreate}
                disabled={!name.trim() || loading}>
                {loading ? 'Summoning lobby…' : '📜 Create Lobby'}
              </button>
            </div>
          )}

          {tab === 'join' && (
            <div className="form-body">
              <label className="form-label">Lobby Code</label>
              <input className="form-input code-input" type="text" maxLength={6}
                placeholder="ABCD12"
                value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
              <label className="form-label">Your Scribe Name</label>
              <input className="form-input" type="text" maxLength={24}
                placeholder="Night Ink, the Wanderer…"
                value={joinName} onChange={e => setJoinName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleJoin()} />
              <button className="btn-primary form-submit" onClick={handleJoin}
                disabled={!joinCode.trim() || !joinName.trim() || loading}>
                {loading ? 'Entering lobby…' : '🗝 Join Lobby'}
              </button>
            </div>
          )}
        </div>

        <div className="how-to">
          <span>👥</span> Up to 4 scribes &nbsp;·&nbsp;
          <span>✍️</span> Take turns &nbsp;·&nbsp;
          <span>🎨</span> AI paints the scene &nbsp;·&nbsp;
          <span>🃏</span> Joker cards
        </div>
      </div>
    </div>
  )
}

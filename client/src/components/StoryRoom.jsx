import { useState, useEffect, useRef } from 'react'
import { socket } from '../socket'
import './StoryRoom.css'

export default function StoryRoom({ lobby, socketId, generatingScene }) {
  const [text,        setText]       = useState('')
  const [jokerActive, setJokerActive] = useState(false)
  const [bgCurrent,   setBgCurrent]  = useState(lobby.currentBackground)
  const [bgPrev,      setBgPrev]     = useState(null)
  const [bgFade,      setBgFade]     = useState(false)
  const [voteConfirm, setVoteConfirm] = useState(null)  // playerId being targeted
  const scrollRef = useRef(null)
  const inputRef  = useRef(null)

  const isMyTurn      = lobby.currentPlayerId === socketId
  const myPlayer      = lobby.players.find(p => p.id === socketId)
  const activePlayer  = lobby.players.find(p => p.id === lobby.currentPlayerId)

  const isFirstTurn     = lobby.firstTurnLimit !== null
  const effectiveBase   = isFirstTurn ? lobby.firstTurnLimit : lobby.wordLimit
  const jokerAvailable  = myPlayer?.jokerAvailable ?? false
  const jokerRechargeIn = myPlayer?.jokerRechargeIn ?? 0
  const canUseJoker     = jokerAvailable && !isFirstTurn
  const effectiveLimit  = jokerActive && canUseJoker ? effectiveBase * 2 : effectiveBase

  const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).filter(Boolean).length
  const overLimit = wordCount > effectiveLimit
  const nearLimit = wordCount >= Math.floor(effectiveLimit * 0.8)

  const vote       = lobby.activeVote
  const myVote     = vote?.votes?.[socketId]
  const iAmTarget  = vote?.targetId === socketId
  const alreadyVoted = myVote !== undefined

  // Background fade — when a new URL arrives, animate it in
  useEffect(() => {
    if (lobby.currentBackground && lobby.currentBackground !== bgCurrent) {
      setBgPrev(bgCurrent)
      setBgCurrent(lobby.currentBackground)
      setBgFade(true)
      // Clear the animation class after it finishes (matches 1.4s in CSS)
      const t = setTimeout(() => { setBgFade(false); setBgPrev(null) }, 1500)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lobby.currentBackground])

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lobby.story])

  useEffect(() => {
    if (isMyTurn && inputRef.current) inputRef.current.focus()
    if (!isMyTurn) setJokerActive(false)
  }, [isMyTurn])

  const handleSubmit = () => {
    if (!isMyTurn || overLimit || wordCount === 0) return
    socket.emit('submit-turn', { text: text.trim(), useJoker: jokerActive })
    setText('')
    setJokerActive(false)
  }

  const handleSkip = () => {
    if (!isMyTurn) return
    socket.emit('skip-turn')
  }

  const handleVoteKick = (targetId) => {
    setVoteConfirm(null)
    socket.emit('initiate-vote-kick', { targetId })
  }

  const handleCastVote = (approve) => {
    socket.emit('cast-vote', { approve })
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
  }

  const fmtTime = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const voteSecondsLeft = vote
    ? Math.max(0, Math.ceil((vote.expiresAt - Date.now()) / 1000))
    : 0

  return (
    <div className="story-room">
      {bgPrev && <div className="bg-layer bg-prev" style={{backgroundImage:`url(${bgPrev})`}} />}
      <div className={`bg-layer bg-current ${bgFade?'fading-in':''}`}
        style={{backgroundImage: bgCurrent?`url(${bgCurrent})`:'none'}} />
      <div className="bg-overlay" />
      {!bgCurrent && <div className="stars-bg" />}

      {/* ── GENERATING SCENE OVERLAY ── */}
      {generatingScene && (
        <div className="generating-overlay">
          <div className="generating-inner">
            <div className="generating-rune">✦</div>
            <p className="generating-title">The Muse is writing…</p>
            <p className="generating-sub">An opening scene is being conjured</p>
            <div className="generating-dots"><span/><span/><span/></div>
          </div>
        </div>
      )}

      {/* ── VOTE KICK CONFIRM TOOLTIP ── */}
      {voteConfirm && (
        <div className="vote-confirm-overlay" onClick={() => setVoteConfirm(null)}>
          <div className="vote-confirm-box" onClick={e => e.stopPropagation()}>
            <p className="vote-confirm-title">Start a vote to remove</p>
            <p className="vote-confirm-name" style={{color: lobby.players.find(p=>p.id===voteConfirm)?.color}}>
              {lobby.players.find(p=>p.id===voteConfirm)?.name}?
            </p>
            <div className="vote-confirm-btns">
              <button className="vote-yes-btn" onClick={() => handleVoteKick(voteConfirm)}>Yes, call vote</button>
              <button className="vote-no-btn"  onClick={() => setVoteConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="room-layout">

        {/* ── HEADER ── */}
        <header className="room-header">
          <div className="room-title-area">
            <span className="room-rune">✦</span>
            <span className="room-title">TaleWeaver</span>
          </div>

          <div className="players-bar">
            {lobby.players.map(p => {
              const gone = p.id?.startsWith('disconnected:')
              const canKick = !gone && p.id !== socketId && lobby.status === 'playing' && !vote
              return (
                <div key={p.id}
                  className={['player-chip', p.id===lobby.currentPlayerId?'active':'', p.id===socketId?'is-me':'', gone?'gone':''].join(' ')}
                  style={{'--pc': p.color}}>
                  <span className="chip-emblem">{p.emblem}</span>
                  <span className="chip-name">{p.name}</span>
                  {p.jokerAvailable && !gone && <span className="chip-joker" title="Has Joker">🃏</span>}
                  {p.id===lobby.currentPlayerId && !gone && <span className="chip-cursor">✍</span>}
                  {canKick && (
                    <button className="chip-kick-btn" title={`Vote to remove ${p.name}`}
                      onClick={() => setVoteConfirm(p.id)}>⚑</button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="room-stats">
            <span title="Total turns">📖 {lobby.promptCount}</span>
            <span className={lobby.nextImageIn<=1?'stat-imminent':''} title="Turns until next painting">
              🎨 {lobby.nextImageIn===6?'next: 6':`in ${lobby.nextImageIn}`}
            </span>
          </div>
        </header>

        {/* ── ACTIVE VOTE BANNER ── */}
        {vote && (
          <div className="vote-banner">
            <div className="vote-banner-info">
              <span className="vote-banner-label">⚑ Vote to remove</span>
              <span className="vote-banner-target">{vote.targetName}</span>
              <span className="vote-banner-count">{vote.votedCount}/{vote.totalVoters} voted · {voteSecondsLeft}s</span>
            </div>
            {!iAmTarget && !alreadyVoted && (
              <div className="vote-banner-btns">
                <button className="vote-yes-btn" onClick={()=>handleCastVote(true)}>👍 Yes</button>
                <button className="vote-no-btn"  onClick={()=>handleCastVote(false)}>👎 No</button>
              </div>
            )}
            {!iAmTarget && alreadyVoted && (
              <span className="vote-voted-label">
                {myVote ? '👍 You voted yes' : '👎 You voted no'}
              </span>
            )}
            {iAmTarget && <span className="vote-voted-label">A vote is being held for your removal.</span>}
          </div>
        )}

        {/* ── STORY SCROLL ── */}
        <main className="story-scroll" ref={scrollRef}>
          {lobby.story.length === 0 && !generatingScene && (
            <div className="story-empty">The page is blank. Begin the tale…</div>
          )}
          <div className="story-text">
            {lobby.story.map((seg, idx) => (
              <span key={idx}
                className={['story-segment',
                  seg.playerId===socketId?'mine':'',
                  seg.usedJoker?'joker-seg':'',
                  seg.isAiScene?'ai-seg':'',
                  seg.isAiTurn?'ai-turn':'',
                ].join(' ')}
                style={{'--pc': seg.playerColor}}
                title={`${seg.playerName}${seg.usedJoker?' · 🃏 Joker':seg.isAiScene?' · Opening Scene':seg.isAiTurn?' · AI Player':''} · ${fmtTime(seg.timestamp)}`}>
                {idx > 0 && ' '}
                {seg.usedJoker  && <span className="joker-mark">🃏</span>}
                {seg.isAiScene  && <span className="ai-mark">✦</span>}
                {seg.isAiTurn   && <span className="ai-turn-mark">✦</span>}
                <span className="seg-emblem">{seg.playerEmblem}</span>
                {seg.text}
              </span>
            ))}
          </div>
        </main>

        {/* ── INPUT AREA ── */}
        <footer className="input-area">
          {isMyTurn ? (
            <div className={`input-panel active ${jokerActive?'joker-mode':''} ${isFirstTurn?'first-turn-mode':''}`}
              style={{'--pc': myPlayer?.color}}>

              {isFirstTurn && (
                <div className="first-turn-banner">
                  📜 Set the scene — 500 words to open the story
                </div>
              )}

              <div className="input-top-row">
                <div className="input-turn-label">
                  <span className="turn-emblem">{myPlayer?.emblem}</span>
                  Your turn, {myPlayer?.name}
                </div>

                <div className="input-top-actions">
                  {canUseJoker ? (
                    <button className={`joker-btn ${jokerActive?'joker-btn-on':''}`}
                      onClick={()=>setJokerActive(v=>!v)}
                      title={jokerActive?'Cancel Joker':`Double limit to ${lobby.wordLimit*2} words`}>
                      🃏 {jokerActive?'Joker ON':'Joker'}
                    </button>
                  ) : !isFirstTurn ? (
                    <div className="joker-cooldown">🃏 {jokerRechargeIn}t</div>
                  ) : null}

                  <button className="skip-btn" onClick={handleSkip} title="Pass your turn">
                    ↩ Pass
                  </button>
                </div>
              </div>

              {jokerActive && (
                <div className="joker-banner">✦ Joker active — limit doubled to {lobby.wordLimit*2} words</div>
              )}

              <div className="input-row">
                <textarea ref={inputRef} className="story-input"
                  placeholder={`Continue the story… (max ${effectiveLimit} words)`}
                  value={text} onChange={e=>setText(e.target.value)}
                  onKeyDown={handleKeyDown} rows={2} maxLength={2000} />
                <button
                  className={`submit-btn ${overLimit?'over':''} ${jokerActive?'joker-submit':''}`}
                  onClick={handleSubmit} disabled={overLimit||wordCount===0} title="Submit (Enter)">
                  {jokerActive?'🃏':'✦'}
                </button>
              </div>

              <div className="input-meta">
                <span className={`word-count ${overLimit?'over':nearLimit?'near':''}`}>
                  {wordCount} / {effectiveLimit} words
                  {isFirstTurn && <span className="first-turn-label"> (scene)</span>}
                  {jokerActive && <span className="joker-label"> (Joker)</span>}
                </span>
                <span className="enter-hint">⏎ submit</span>
              </div>
            </div>
          ) : (
            <div className="input-panel waiting-turn" style={{'--pc': activePlayer?.color}}>
              <div className="waiting-turn-inner">
                <span className="waiting-emblem">{activePlayer?.emblem}</span>
                {activePlayer?.isAiPlayer ? (
                  <span className="waiting-text">
                    <strong className="ai-name">{activePlayer?.name}</strong> is conjuring…
                  </span>
                ) : (
                  <span className="waiting-text">
                    <strong>{activePlayer?.name}</strong> is weaving the tale…
                  </span>
                )}
                <div className="waiting-dots"><span/><span/><span/></div>
              </div>
              {myPlayer && (
                <div className="your-joker-status">
                  {myPlayer.jokerAvailable
                    ? '🃏 Joker ready'
                    : `🃏 recharges in ${myPlayer.jokerRechargeIn} turn${myPlayer.jokerRechargeIn!==1?'s':''}`}
                </div>
              )}
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}

import { socket } from '../socket'
import './LobbyWaiting.css'

export default function LobbyWaiting({ lobby, socketId }) {
  const isHost = lobby.hostId === socketId

  const copyCode = () => {
    navigator.clipboard.writeText(lobby.code)
  }

  const startGame = () => {
    socket.emit('start-game')
  }

  return (
    <div className="waiting">
      <div className="stars-bg" />

      <div className="waiting-center">

        {/* ── TITLE ── */}
        <div className="waiting-title-row">
          <div className="waiting-ornament">✦</div>
          <h2 className="waiting-title">The Scriptorium</h2>
          <div className="waiting-ornament">✦</div>
        </div>
        <p className="waiting-sub">Awaiting your fellow scribes…</p>

        {/* ── CODE BOX ── */}
        <div className="code-box">
          <span className="code-label">Lobby Code</span>
          <div className="code-display">
            <span className="code-letters">{lobby.code}</span>
            <button className="code-copy-btn" onClick={copyCode} title="Copy code">
              ⎘
            </button>
          </div>
          <span className="code-hint">Share this with your scribes</span>
        </div>

        {/* ── PLAYERS ── */}
        <div className="players-section">
          <div className="section-label">
            Scribes Assembled
            <span className="count-badge">{lobby.players.length} / 4</span>
          </div>

          <div className="player-list">
            {lobby.players.map((player, idx) => (
              <div
                key={player.id}
                className="player-row"
                style={{ '--pc': player.color }}
              >
                <div className="player-emblem" style={{ color: player.color }}>
                  {player.emblem}
                </div>
                <span className="player-row-name">{player.name}</span>
                <div className="player-badges">
                  {player.id === socketId && (
                    <span className="badge-you">You</span>
                  )}
                  {player.id === lobby.hostId && (
                    <span className="badge-host">Host</span>
                  )}
                </div>
              </div>
            ))}

            {/* Empty slots */}
            {Array.from({ length: 4 - lobby.players.length }).map((_, i) => (
              <div key={`empty-${i}`} className="player-row empty">
                <div className="player-emblem empty-slot">⬡</div>
                <span className="player-row-name empty-name">Waiting for scribe…</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── SETTINGS SUMMARY ── */}
        <div className="settings-summary">
          <span>📏</span>
          <span><strong>{lobby.wordLimit}</strong> words per turn</span>
          <span>·</span>
          <span>🎨</span>
          <span>New scene painting every <strong>6</strong> turns</span>
        </div>

        {/* ── START / WAITING ── */}
        {isHost ? (
          <div className="start-section">
            <button
              className="btn-primary start-btn"
              onClick={startGame}
              disabled={lobby.players.length < 2}
            >
              {lobby.players.length < 2
                ? 'Need at least 2 scribes…'
                : '⚡ Begin the Story'}
            </button>
            {lobby.players.length < 2 && (
              <p className="start-hint">
                Share the code above to invite more scribes.
              </p>
            )}
          </div>
        ) : (
          <div className="host-waiting">
            <div className="spinner" />
            <p>Waiting for the host to begin the tale…</p>
          </div>
        )}

      </div>
    </div>
  )
}

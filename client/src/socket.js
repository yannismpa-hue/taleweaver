import { io } from 'socket.io-client'

// In production, connect to the same origin (Express serves both).
// In dev, Vite proxies /socket.io → localhost:3001.
const URL = import.meta.env.PROD ? window.location.origin : '/'

export const socket = io(URL, {
  autoConnect: true,
  transports: ['websocket', 'polling'],
})

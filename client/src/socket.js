import { io } from 'socket.io-client'

const URL = import.meta.env.PROD ? window.location.origin : '/'

export const socket = io(URL, {
  autoConnect: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 8000,
  timeout: 20000,
})

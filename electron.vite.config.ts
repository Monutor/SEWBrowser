import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    // Явный IPv4: Vite по умолчанию слушает 'localhost' (-> ::1),
    // а IPv6-loopback на некоторых машинах отрезан (EACCES: VPN/файрвол) —
    // dev тогда белый экран + ERR_CONNECTION_REFUSED.
    server: { host: '127.0.0.1', port: 5173 },
  },
})

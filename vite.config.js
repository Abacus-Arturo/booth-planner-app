import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './', // rutas relativas: funciona sin importar bajo qué subcarpeta lo sirva GitHub Pages
})

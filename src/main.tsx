import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import { App } from './App'

const el = document.getElementById('root')
if (!el) throw new Error('#root 不存在')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

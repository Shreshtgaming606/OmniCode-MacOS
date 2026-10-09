import omniLogo from '../../assets/omni-mode-logo.jpg'
import './OmniModeLogo.css'

export function OmniModeLogo({ className = '' }: { className?: string }) {
  return <span className={`omni-mode-logo ${className}`} role="img" aria-label="Omni Mode logo"><img src={omniLogo} alt="" draggable={false} /></span>
}

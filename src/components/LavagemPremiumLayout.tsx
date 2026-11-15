import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import '../styles/lavagem-premium.css';

interface Props {
  children: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
}

export default function LavagemPremiumLayout({ children, refreshing, onRefresh }: Props) {
  return <section className="lavagem-premium" aria-label="Módulo Lavagem e Lubrificação">
    <div className="lavagem-premium-ribbons" aria-hidden="true" />
    <header className="lavagem-premium-hero">
      <div className="lavagem-premium-brand">
        <img src="/logo.png" alt="Branco Peres Agro S/A" />
        <div><h2>Lavagem e Lubrificação</h2><p>BRANCO PERES AGRO</p></div>
      </div>
      <button type="button" className="lavagem-premium-sync" disabled={refreshing} onClick={onRefresh}>
        <RefreshCw size={18} aria-hidden="true" className={refreshing ? 'animate-spin' : ''}/>
        {refreshing ? 'Sincronizando…' : 'Sincronizar'}
      </button>
    </header>
    <div className="lavagem-premium-body">{children}</div>
  </section>;
}

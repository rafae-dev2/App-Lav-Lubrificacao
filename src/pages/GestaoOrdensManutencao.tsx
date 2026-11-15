import React from 'react';

const ORDENS_URL = 'https://ti.usinabrancoperes.com.br/ordens-pims/';

export default function GestaoOrdensManutencao() {
  return (
    <iframe
      src={ORDENS_URL}
      title="Gestão de Ordens Manutenção"
      className="block w-full flex-1 min-h-0 border-0"
      style={{ backgroundColor: '#ffffff' }}
      // Permite o funcionamento do site, mas impede pop-ups e navegação
      // da janela principal para fora do aplicativo.
      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
    />
  );
}

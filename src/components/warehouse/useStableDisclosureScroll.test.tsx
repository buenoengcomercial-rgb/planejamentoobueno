import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useStableDisclosureScroll from './useStableDisclosureScroll';

function Fixture() {
  const [expanded, setExpanded] = useState(true);
  const { reserveHeight, toggle } = useStableDisclosureScroll(expanded);
  return <div data-testid="scroll-host" style={{ height: 500, overflowY: 'auto' }}>
    <table><tbody>
      <tr aria-label="Registro" aria-expanded={expanded} onClick={event => toggle(event.currentTarget, () => setExpanded(current => !current))}><td>Registro</td></tr>
      {expanded && <tr data-testid="withdrawal-history-details"><td>Detalhes</td></tr>}
    </tbody></table>
    <div data-testid="scroll-reserve" style={{ height: reserveHeight }} aria-hidden="true" />
  </div>;
}

describe('rolagem ao recolher detalhes', () => {
  it('reserva somente o espaço necessário para impedir que a posição clicada seja truncada', () => {
    render(<Fixture />);
    const host = screen.getByTestId('scroll-host');
    const details = screen.getByTestId('withdrawal-history-details');
    Object.defineProperty(host, 'scrollHeight', { configurable: true, value: 800 });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 500 });
    Object.defineProperty(host, 'scrollTop', { configurable: true, writable: true, value: 260 });
    Object.defineProperty(details, 'getBoundingClientRect', { configurable: true, value: () => ({ height: 200, top: 0 }) });

    fireEvent.click(screen.getByRole('row', { name: 'Registro' }));

    expect(screen.queryByTestId('withdrawal-history-details')).not.toBeInTheDocument();
    expect(screen.getByTestId('scroll-reserve')).toHaveStyle({ height: '160px' });
    expect(host.scrollTop).toBe(260);

    host.scrollTop = 0;
    fireEvent.scroll(host);
    expect(screen.getByTestId('scroll-reserve')).toHaveStyle({ height: '0px' });
  });
});

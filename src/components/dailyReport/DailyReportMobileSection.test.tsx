import { fireEvent, render, screen } from '@testing-library/react';
import { DailyReportMobileSection } from './DailyReportMobileSection';

describe('DailyReportMobileSection', () => {
  it('starts collapsed for mobile and opens its existing content on touch', () => {
    render(
      <DailyReportMobileSection title="Equipe presente" summary="Nenhuma equipe lançada.">
        <p>Conteúdo da equipe</p>
      </DailyReportMobileSection>,
    );

    const trigger = screen.getByRole('button', { name: /equipe presente/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Conteúdo da equipe').parentElement).toHaveClass('hidden', 'lg:block');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Conteúdo da equipe').parentElement).toHaveClass('block', 'lg:mt-0');
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import AdditiveTotalsBlock from './AdditiveTotalsBlock';
import type { Additive } from '@/types/project';
it('mantém a digitação local e confirma o limite somente ao sair do campo', () => {
 const onChangeLimit=vi.fn();
 render(<AdditiveTotalsBlock active={{id:'a',aditivoLimitPercent:50} as Additive} totals={{totalContratadoOriginal:100,totalSuprimido:0,totalAcrescido:0,valorFinal:100,percentSupressao:0,percentAcrescimo:0,limitStatus:'ok',limitPercent:50}} isLocked={false} onChangeLimit={onChangeLimit}/>);
 const input=screen.getByRole('spinbutton');
 fireEvent.change(input,{target:{value:'25'}}); expect(onChangeLimit).not.toHaveBeenCalled();
 fireEvent.blur(input); expect(onChangeLimit).toHaveBeenCalledExactlyOnceWith(25);
});

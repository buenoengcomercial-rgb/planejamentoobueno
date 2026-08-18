import { describe, expect, it } from 'vitest';
import { equipmentAiBackendError, equipmentAiErrorMessage } from './equipmentAi';

function httpError(status: number, body: unknown) {
  return Object.assign(new Error('Edge Function returned a non-2xx status code'), {
    name: 'FunctionsHttpError',
    context: {
      status,
      clone() { return this; },
      async json() { return body; },
    },
  });
}

describe('equipmentAiErrorMessage', () => {
  it('explica quando a Edge Function não foi implantada ou está indisponível', async () => {
    const error = Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' });
    expect(await equipmentAiErrorMessage(error)).toContain('indisponível ou não foi implantado');
  });

  it.each([
    [401, 'sessão expirou'],
    [402, 'créditos da IA'],
    [429, 'limite de leituras'],
  ])('traduz o status HTTP %i', async (status, expected) => {
    expect(await equipmentAiErrorMessage(httpError(status, {}))).toContain(expected);
  });

  it('explica quando a chave do Lovable está ausente', async () => {
    expect(await equipmentAiErrorMessage(httpError(500, { error: 'LOVABLE_API_KEY ausente para a leitura por IA.' })))
      .toContain('integração com a IA do Lovable não está configurada');
  });

  it('traduz JSON inválido e preserva o cadastro manual', async () => {
    const error = equipmentAiBackendError('IA retornou JSON invalido.');
    const message = await equipmentAiErrorMessage(error);
    expect(message).toContain('formato inválido');
    expect(message).toContain('cadastro manual continua disponível');
  });

  it('preserva a explicação quando nenhuma informação está legível', async () => {
    const error = equipmentAiBackendError('Não foi possível identificar dados legíveis nas fotos.');
    expect(await equipmentAiErrorMessage(error)).toContain('dados legíveis nas fotos');
  });
});

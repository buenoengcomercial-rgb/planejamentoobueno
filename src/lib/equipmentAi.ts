type EdgeErrorResponse = {
  status?: number;
  clone?: () => EdgeErrorResponse;
  json?: () => Promise<unknown>;
};

type EdgeFunctionError = Error & {
  context?: EdgeErrorResponse;
};

const manualFallback = 'O cadastro manual continua disponível.';

function messageFromStatus(status: number | undefined) {
  if (status === 401 || status === 403) return 'Sua sessão expirou ou não autoriza a leitura por IA. Entre novamente e tente outra vez.';
  if (status === 402) return 'Os créditos da IA do Lovable estão esgotados. Adicione créditos para reativar a leitura.';
  if (status === 404) return 'O serviço de leitura de equipamentos ainda não está disponível neste ambiente.';
  if (status === 429) return 'O limite de leituras por IA foi atingido. Aguarde alguns instantes e tente novamente.';
  return null;
}

function messageFromBackend(message: string) {
  const normalized = message.toLocaleLowerCase('pt-BR');
  if (normalized.includes('lovable_api_key') || normalized.includes('api key')) {
    return 'A integração com a IA do Lovable não está configurada neste ambiente.';
  }
  if (normalized.includes('crédito') || normalized.includes('credit')) {
    return 'Os créditos da IA do Lovable estão esgotados. Adicione créditos para reativar a leitura.';
  }
  if (normalized.includes('limite de requisi') || normalized.includes('rate limit')) {
    return 'O limite de leituras por IA foi atingido. Aguarde alguns instantes e tente novamente.';
  }
  if (normalized.includes('json inválido') || normalized.includes('json invalido')) {
    return 'A IA respondeu em um formato inválido. Tente novamente com fotos mais nítidas.';
  }
  return message;
}

async function readContext(error: EdgeFunctionError) {
  const context = error.context;
  if (!context?.json) return { status: context?.status, message: null as string | null };
  try {
    const response = context.clone ? context.clone() : context;
    const body = await response.json?.() as { error?: unknown; message?: unknown } | undefined;
    const message = body?.error ?? body?.message;
    return { status: context.status, message: typeof message === 'string' ? message : null };
  } catch {
    return { status: context.status, message: null as string | null };
  }
}

export async function equipmentAiErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return `Não foi possível concluir a leitura por IA. ${manualFallback}`;

  const edgeError = error as EdgeFunctionError;
  const context = await readContext(edgeError);
  const statusMessage = messageFromStatus(context.status);
  if (statusMessage) return `${statusMessage} ${manualFallback}`;
  if (context.message) return `${messageFromBackend(context.message)} ${manualFallback}`;

  if (edgeError.name === 'FunctionsFetchError' || /failed to send a request to the edge function/i.test(edgeError.message)) {
    return `O serviço de leitura por IA está indisponível ou não foi implantado neste ambiente. ${manualFallback}`;
  }
  if (edgeError.name === 'FunctionsRelayError') {
    return `O serviço de leitura por IA não respondeu. Tente novamente em instantes. ${manualFallback}`;
  }

  return `${messageFromBackend(edgeError.message || 'Não foi possível concluir a leitura por IA.')} ${manualFallback}`;
}

export function equipmentAiBackendError(message?: string) {
  return new Error(messageFromBackend(message || 'Não foi possível ler o equipamento.'));
}

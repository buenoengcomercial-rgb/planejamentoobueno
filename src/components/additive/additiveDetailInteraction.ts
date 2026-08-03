export function shouldDismissAdditiveDetail(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;

  return !target.closest([
    '[data-detail-cell="true"]',
    '[data-additive-composition-row="true"]',
    '[data-detail-panel="true"]',
    '[data-detail-footer="true"]',
  ].join(', '));
}

export function openModalReview(
  dialog: HTMLDialogElement,
  returnFocus: HTMLElement | null,
  fallbackFocus: HTMLElement | null,
): () => void {
  const scroller = (returnFocus ?? fallbackFocus)?.closest<HTMLElement>(".page-body");
  const top = scroller?.scrollTop ?? 0;
  const left = scroller?.scrollLeft ?? 0;
  const restoreScroll = () => {
    if (!scroller?.isConnected) return;
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  };
  dialog.showModal();
  restoreScroll();
  return () => {
    if (dialog.open) dialog.close();
    // React may remove the answered request in the same commit that closes the modal.
    queueMicrotask(() => {
      if (dialog.ownerDocument.querySelector("dialog:modal")) return;
      const target =
        returnFocus?.isConnected && !returnFocus.matches(":disabled") ? returnFocus : fallbackFocus;
      if (!target?.isConnected) return;
      target.focus({ preventScroll: true });
      restoreScroll();
    });
  };
}

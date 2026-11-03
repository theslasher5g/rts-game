/** Steuert den vorhandenen #loading-Bildschirm aus index.html. */

function el(): HTMLElement | null {
  return document.getElementById('loading');
}

export function setLoading(p: number, label: string): void {
  const root = el();
  if (!root) return;
  const bar = root.querySelector<HTMLElement>('.loading-bar > div');
  const text = root.querySelector<HTMLElement>('.loading-text');
  const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
  if (bar) bar.style.width = `${pct}%`;
  if (text) text.textContent = `${label} [${String(pct).padStart(3, ' ')}%]`;
}

export function hideLoading(): void {
  const root = el();
  if (!root || root.classList.contains('error')) return;
  setLoading(1, 'Bereit');
  root.classList.add('fade');
  window.setTimeout(() => {
    if (!root.classList.contains('error')) root.style.display = 'none';
  }, 650);
}

export function showLoadingError(msg: string): void {
  const root = el();
  if (!root) return;
  root.style.display = '';
  root.classList.remove('fade');
  root.classList.add('error');
  const text = root.querySelector<HTMLElement>('.loading-text');
  if (text) text.textContent = `FEHLER: ${msg}`;
}

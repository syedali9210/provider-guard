// Sets the theme before first paint (an external file, so the CSP needs no 'unsafe-inline').
try {
  const preference = localStorage.getItem('provider-guard-theme') || 'system'
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch {}

// The two HTML pages people see: the Pubky Ring QR code (sign-in and account
// linking share it) and a plain message page.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const STYLE = `
  body{font-family:system-ui,sans-serif;background:#0f1115;color:#e8e8e8;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box;overflow-wrap:break-word}
  main{max-width:380px;width:100%;text-align:center}
  h1{font-size:1.4rem;text-wrap:balance}
  p{color:#b4b8c0;text-wrap:pretty}
  img{width:100%;max-width:280px;height:auto;background:#fff;padding:12px;border-radius:12px;box-sizing:border-box}
  a.btn{display:inline-block;max-width:100%;margin-top:16px;padding:12px 20px;min-height:44px;box-sizing:border-box;border-radius:10px;background:#f2a900;color:#111;font-weight:600;text-decoration:none}
  code{font-size:.85em;word-break:break-all}
  #status{min-height:1.5em}`

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`
}

export function messagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`)
}

// `statusUrl` answers { state, message?, qr?, link?, title?, lead? } and the
// page follows it: a new QR code when the step changes, then `next` or a message.
export function ringPage(opts: { title: string; lead: string; qr: string; link: string; statusUrl: string }): string {
  return page(
    opts.title,
    `<h1 id="title">${escapeHtml(opts.title)}</h1>
  <p id="lead">${escapeHtml(opts.lead)}</p>
  <img id="qr" src="${opts.qr}" alt="Pubky Ring QR code" width="280" height="280">
  <p><a id="open" class="btn" href="${escapeHtml(opts.link)}">Open Pubky&nbsp;Ring on this phone</a></p>
  <p id="status" role="status">Waiting for approval…</p>
<script>
  const $ = (id) => document.getElementById(id)
  async function poll() {
    try {
      const r = await fetch(${JSON.stringify(opts.statusUrl)}, { cache: 'no-store' })
      const j = await r.json()
      if (j.qr) { $('qr').src = j.qr; $('open').href = j.link; $('title').textContent = j.title; $('lead').textContent = j.lead; $('status').textContent = 'Waiting for approval…' }
      if (j.state === 'next') { $('status').textContent = 'Approved, continuing…'; location.href = j.next; return }
      if (j.state === 'done') { $('qr').hidden = true; $('open').hidden = true; $('status').textContent = j.message; return }
      if (j.state === 'error') { $('status').textContent = j.message + ' Reload the page for a new code.'; return }
      if (j.state === 'expired') { $('status').textContent = 'This code has expired. Reload the page.'; return }
    } catch { /* network: try again */ }
    setTimeout(poll, 1500)
  }
  poll()
</script>`,
  )
}

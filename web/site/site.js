// Website interactions: install tabs, copy buttons, ciphertext ticker, reveal on scroll.
(() => {
  // On static hosting (e.g. GitHub Pages) there is no relay, so point CTAs to the install guide.
  if (/github\.io$/.test(location.hostname)) {
    document.querySelectorAll('.js-app').forEach((a) => { a.href = '#install'; a.textContent = 'Installieren'; });
  }

  const tabs = document.querySelectorAll('.tabs button');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
  }));
  if (/Mac/.test(navigator.platform)) document.querySelector('[data-tab="mac"]')?.click();
  else if (/Win/.test(navigator.platform)) document.querySelector('[data-tab="win"]')?.click();

  document.querySelectorAll('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.textContent = 'Kopieren';
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.querySelector('code').innerText); btn.textContent = 'Kopiert ✓'; } catch { btn.textContent = 'Markieren & kopieren'; }
      setTimeout(() => (btn.textContent = 'Kopieren'), 1600);
    });
    pre.append(btn);
  });

  const hexChars = '0123456789abcdef';
  const cipher = document.getElementById('cipher');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = (n, set) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => set[b % set.length]).join('');
  if (cipher) {
    const tick = () => { cipher.textContent = rnd(56, hexChars); };
    tick();
    if (!reduce) setInterval(tick, 140);
  }
  const code = document.getElementById('paper-code');
  if (code) {
    const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const g = () => rnd(4, A);
    code.textContent = '';
    code.append(`${g()}-${g()}-${g()}-${g()}`, document.createElement('br'), `${g()}-${g()}-${g()}-${g()}`);
  }

  if (!reduce && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
    document.querySelectorAll('.section-head, .steps li, .tile, .col, .flow, .table-wrap, .honest, .faq, .cta-final').forEach((el) => { el.classList.add('reveal'); io.observe(el); });
  }
})();

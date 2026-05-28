/** Page admin HTML servie par le Worker à GET /admin */
export function adminPage(): Response {
  const html = /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TechPulse — Admin Sources</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f12; color: #e2e8f0; min-height: 100vh; }
    header { padding: 20px 24px; border-bottom: 1px solid #1e2330; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 1.2rem; font-weight: 700; color: #a78bfa; }
    header span { font-size: .8rem; color: #64748b; }
    main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }

    /* Auth */
    #auth { display: flex; flex-direction: column; gap: 12px; max-width: 360px; margin: 60px auto; }
    #auth input { padding: 10px 14px; border-radius: 8px; border: 1px solid #2d3748; background: #1a1f2e; color: #e2e8f0; font-size: .9rem; }
    #auth button { padding: 10px; border-radius: 8px; background: #7c3aed; color: #fff; border: none; cursor: pointer; font-weight: 600; }

    /* Toolbar */
    .toolbar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .toolbar select, .toolbar input { padding: 8px 12px; border-radius: 8px; border: 1px solid #2d3748; background: #1a1f2e; color: #e2e8f0; font-size: .85rem; }
    .btn { padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; font-size: .85rem; font-weight: 600; transition: opacity .15s; }
    .btn:hover { opacity: .8; }
    .btn-primary { background: #7c3aed; color: #fff; }
    .btn-danger  { background: #dc2626; color: #fff; }
    .btn-muted   { background: #1e2330; color: #94a3b8; }

    /* Table */
    table { width: 100%; border-collapse: collapse; font-size: .85rem; }
    th { text-align: left; padding: 10px 12px; color: #64748b; border-bottom: 1px solid #1e2330; font-weight: 600; }
    td { padding: 10px 12px; border-bottom: 1px solid #1a1f2e; vertical-align: middle; }
    tr:hover td { background: #141820; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: .75rem; font-weight: 700; }
    .badge-on  { background: #14532d; color: #4ade80; }
    .badge-off { background: #450a0a; color: #f87171; }
    .badge-theme { background: #1e1b4b; color: #a5b4fc; margin-right: 4px; }
    .tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: .72rem; background: #1e2330; color: #94a3b8; }

    /* Modale */
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 100; align-items: center; justify-content: center; }
    .modal-bg.open { display: flex; }
    .modal { background: #161b27; border: 1px solid #2d3748; border-radius: 12px; padding: 24px; width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 14px; }
    .modal h2 { font-size: 1rem; font-weight: 700; }
    .modal label { font-size: .8rem; color: #94a3b8; display: flex; flex-direction: column; gap: 4px; }
    .modal input, .modal select { padding: 9px 12px; border-radius: 8px; border: 1px solid #2d3748; background: #0f0f12; color: #e2e8f0; font-size: .85rem; }
    .modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }

    #status { padding: 10px 14px; border-radius: 8px; background: #1e2330; font-size: .82rem; margin-bottom: 14px; display: none; }
    #status.ok  { background: #14532d; color: #4ade80; display: block; }
    #status.err { background: #450a0a; color: #f87171; display: block; }
  </style>
</head>
<body>

<header>
  <h1>⚡ TechPulse</h1>
  <span>Admin Sources</span>
  <div style="margin-left:auto;display:flex;gap:8px">
    <button class="btn btn-muted" onclick="triggerCron()">▶ Cron maintenant</button>
    <button class="btn btn-primary" onclick="openModal()">+ Ajouter</button>
  </div>
</header>

<main>
  <!-- Auth -->
  <div id="auth">
    <h2 style="text-align:center;margin-bottom:4px">🔑 Connexion</h2>
    <input id="secretInput" type="password" placeholder="API Secret" />
    <button onclick="login()">Accéder</button>
  </div>

  <!-- Contenu -->
  <div id="app" style="display:none">
    <div id="status"></div>

    <div class="toolbar">
      <select id="themeFilter" onchange="loadSources()">
        <option value="">Tous les thèmes</option>
        <option value="youtube">YouTube</option>
        <option value="general">Développement</option>
        <option value="ai">IA & Data</option>
        <option value="mobile">Mobile / Expo</option>
        <option value="business">Business</option>
        <option value="startups">Startups</option>
        <option value="opensource">Open Source</option>
        <option value="productivity">Productivité</option>
      </select>
      <input id="search" type="search" placeholder="Filtrer…" oninput="renderTable()" style="flex:1;min-width:140px" />
    </div>

    <table>
      <thead>
        <tr>
          <th>Nom</th><th>Thème</th><th>Type</th><th>Valeur</th><th>Limite</th><th>Statut</th><th></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
</main>

<!-- Modale ajout -->
<div class="modal-bg" id="modalBg">
  <div class="modal">
    <h2>Nouvelle source</h2>
    <label>Nom <input id="mName" placeholder="Ex: Fireship" /></label>
    <label>Thème
      <select id="mTheme">
        <option value="youtube">YouTube</option>
        <option value="general">Développement</option>
        <option value="ai">IA & Data</option>
        <option value="mobile">Mobile / Expo</option>
        <option value="business">Business</option>
        <option value="startups">Startups</option>
        <option value="opensource">Open Source</option>
        <option value="productivity">Productivité</option>
      </select>
    </label>
    <label>Type
      <select id="mType">
        <option value="youtube_channel">YouTube Channel</option>
        <option value="rss">RSS</option>
        <option value="reddit_rss">Reddit</option>
        <option value="devto_tag">Dev.to tag</option>
        <option value="hackernews_rss">Hacker News RSS</option>
      </select>
    </label>
    <label>Valeur (URL ou Channel ID)
      <input id="mValue" placeholder="Ex: UCVHFbw7woebKtFFBqfpq6aA" />
    </label>
    <label>Limite articles
      <input id="mLimit" type="number" value="5" min="1" max="20" />
    </label>
    <div class="modal-actions">
      <button class="btn btn-muted" onclick="closeModal()">Annuler</button>
      <button class="btn btn-primary" onclick="addSource()">Créer</button>
    </div>
  </div>
</div>

<script>
  const BASE = window.location.origin;
  let secret = '';
  let allSources = [];

  function setStatus(msg, ok) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = ok ? 'ok' : 'err';
    setTimeout(() => { el.className = ''; el.textContent = ''; }, 3500);
  }

  function login() {
    secret = document.getElementById('secretInput').value.trim();
    if (!secret) return;
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    loadSources();
  }

  async function apiFetch(path, opts = {}) {
    return fetch(BASE + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret, ...(opts.headers || {}) },
    });
  }

  async function loadSources() {
    const theme = document.getElementById('themeFilter').value;
    const res = await apiFetch('/sources' + (theme ? '?theme=' + theme : ''));
    const data = await res.json();
    allSources = data.sources || [];
    renderTable();
  }

  function renderTable() {
    const q = document.getElementById('search').value.toLowerCase();
    const rows = allSources.filter(s =>
      !q || s.name.toLowerCase().includes(q) || s.value.toLowerCase().includes(q)
    );
    const tbody = document.getElementById('tbody');
    tbody.innerHTML = rows.map(s => \`
      <tr>
        <td><strong>\${s.name}</strong></td>
        <td><span class="badge badge-theme">\${s.theme}</span></td>
        <td><span class="tag">\${s.type}</span></td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b">\${s.value}</td>
        <td style="color:#94a3b8">\${s.limit_count}</td>
        <td><span class="badge \${s.is_active ? 'badge-on' : 'badge-off'}">\${s.is_active ? 'Actif' : 'Inactif'}</span></td>
        <td style="display:flex;gap:6px">
          <button class="btn btn-muted" onclick="toggleSource('\${s.id}', \${s.is_active})">
            \${s.is_active ? 'Pause' : 'Activer'}
          </button>
          \${!s.is_default ? \`<button class="btn btn-danger" onclick="deleteSource('\${s.id}')">✕</button>\` : ''}
        </td>
      </tr>
    \`).join('');
  }

  async function toggleSource(id, currentActive) {
    await apiFetch('/sources/' + id, { method: 'PUT', body: JSON.stringify({ is_active: currentActive ? 0 : 1 }) });
    await loadSources();
    setStatus(currentActive ? 'Source mise en pause' : 'Source activée', true);
  }

  async function deleteSource(id) {
    if (!confirm('Supprimer cette source ?')) return;
    await apiFetch('/sources/' + id, { method: 'DELETE' });
    await loadSources();
    setStatus('Source supprimée', true);
  }

  async function addSource() {
    const body = {
      name: document.getElementById('mName').value.trim(),
      theme: document.getElementById('mTheme').value,
      type: document.getElementById('mType').value,
      value: document.getElementById('mValue').value.trim(),
      limit_count: Number(document.getElementById('mLimit').value),
    };
    if (!body.name || !body.value) { setStatus('Nom et valeur requis', false); return; }
    const res = await apiFetch('/sources', { method: 'POST', body: JSON.stringify(body) });
    if (res.ok) {
      closeModal();
      await loadSources();
      setStatus('Source créée ✓', true);
    } else {
      setStatus('Erreur lors de la création', false);
    }
  }

  async function triggerCron() {
    const res = await apiFetch('/cron/trigger', { method: 'POST' });
    setStatus(res.ok ? 'Cron lancé — articles disponibles dans ~30s' : 'Erreur cron', res.ok);
  }

  function openModal() { document.getElementById('modalBg').classList.add('open'); }
  function closeModal() {
    document.getElementById('modalBg').classList.remove('open');
    ['mName','mValue'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('mLimit').value = '5';
  }

  document.getElementById('secretInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  document.getElementById('modalBg').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

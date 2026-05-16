/* =========================================================
   Design Packs — Markdown Renderer  (client-side app logic)
   ========================================================= */

(function () {
  'use strict';

  // ─── DOM refs ───
  const fileTreeEl = document.getElementById('file-tree');
  const markdownBody = document.getElementById('markdown-body');
  const welcomeScreen = document.getElementById('welcome-screen');
  const docView = document.getElementById('doc-view');
  const breadcrumbEl = document.getElementById('breadcrumb');
  const tocList = document.getElementById('toc-list');
  const tocPanel = document.getElementById('toc-panel');
  const btnToc = document.getElementById('btn-toc');
  const searchInput = document.getElementById('search-input');
  const welcomeStats = document.getElementById('welcome-stats');

  let treeData = [];
  let currentPath = null;
  let tocVisible = true;

  // ─── Mermaid init ───
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#252636',
      primaryColor: '#3b3d56',
      primaryTextColor: '#cdd6f4',
      primaryBorderColor: '#45475a',
      lineColor: '#7f849c',
      secondaryColor: '#313244',
      tertiaryColor: '#2a2b3d',
      fontFamily: 'Inter, sans-serif',
      fontSize: '13px',
    },
    flowchart: { htmlLabels: true, curve: 'basis' },
    sequence: { mirrorActors: false },
  });

  // ─── Marked config with custom renderer ───
  const renderer = new marked.Renderer();
  let mermaidIdCounter = 0;

  renderer.code = function ({ text, lang }) {
    if (lang === 'mermaid') {
      const id = `mermaid-${mermaidIdCounter++}`;
      return `<div class="mermaid-container"><div class="mermaid" id="${id}">${escapeHtml(text)}</div></div>`;
    }

    // Syntax highlight with highlight.js (with fallback if not loaded)
    let highlighted = escapeHtml(text);
    if (typeof hljs !== 'undefined') {
      if (lang && hljs.getLanguage(lang)) {
        try {
          highlighted = hljs.highlight(text, { language: lang }).value;
        } catch (_) { /* fallback to plain */ }
      } else {
        try {
          highlighted = hljs.highlightAuto(text).value;
        } catch (_) { /* fallback */ }
      }
    }

    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre${langAttr}><code>${highlighted}</code></pre>`;
  };

  marked.setOptions({
    renderer,
    gfm: true,
    breaks: false,
  });

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── File tree ───
  async function loadTree() {
    const res = await fetch('/api/tree');
    treeData = await res.json();
    renderTree(treeData, fileTreeEl, '');
    renderStats(treeData);
  }

  function countItems(nodes) {
    let folders = 0, files = 0;
    for (const n of nodes) {
      if (n.type === 'directory') {
        folders++;
        const sub = countItems(n.children || []);
        folders += sub.folders;
        files += sub.files;
      } else {
        files++;
      }
    }
    return { folders, files };
  }

  function renderStats(tree) {
    const { folders, files } = countItems(tree);
    welcomeStats.innerHTML = `
      <div class="stat-card"><span class="stat-value">${folders}</span><span class="stat-label">Design Packs</span></div>
      <div class="stat-card"><span class="stat-value">${files}</span><span class="stat-label">Documents</span></div>
    `;
  }

  function renderTree(nodes, container, parentPath) {
    container.innerHTML = '';
    for (const node of nodes) {
      if (node.type === 'directory') {
        const folder = document.createElement('div');
        folder.className = 'tree-folder';
        folder.dataset.path = node.path;

        const label = document.createElement('div');
        label.className = 'tree-folder-label';
        label.innerHTML = `
          <svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>
          <svg class="folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          <span class="folder-name" title="${node.name}">${formatFolderName(node.name)}</span>
        `;

        const children = document.createElement('div');
        children.className = 'tree-children';

        label.addEventListener('click', () => {
          const chevron = label.querySelector('.chevron');
          chevron.classList.toggle('open');
          children.classList.toggle('expanded');
        });

        folder.appendChild(label);
        folder.appendChild(children);
        container.appendChild(folder);

        if (node.children && node.children.length) {
          renderTree(node.children, children, node.path);
        }
      } else {
        const file = document.createElement('div');
        file.className = 'tree-file';
        file.dataset.path = node.path;

        const iconClass = node.ext === '.json' ? 'json' : 'md';
        const icon = node.ext === '.json'
          ? '<svg class="file-icon json" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>'
          : '<svg class="file-icon md" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>';

        file.innerHTML = `${icon}<span class="file-name" title="${node.name}">${node.name}</span>`;

        file.addEventListener('click', () => loadFile(node.path, true));
        container.appendChild(file);
      }
    }
  }

  function formatFolderName(name) {
    // Pretty-print date-prefixed folder names
    const match = name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
    if (match) {
      const slug = match[2].replace(/-/g, ' ');
      return `<span style="color:var(--text-muted);font-weight:400;font-size:11px;">${match[1]}</span> ${slug}`;
    }
    return name;
  }

  // ─── Load & render file ───
  async function loadFile(filePath, force = false, fromHash = false) {
    if (!force && currentPath === filePath) return;
    currentPath = filePath;

    // Sync URL hash (skip if we're already responding to a hash change)
    if (!fromHash) {
      const newHash = '#file=' + encodeURIComponent(filePath);
      if (window.location.hash !== newHash) {
        history.pushState(null, '', newHash);
      }
    }

    // Update active state in tree
    document.querySelectorAll('.tree-file.active').forEach(el => el.classList.remove('active'));
    const fileEl = document.querySelector(`.tree-file[data-path="${CSS.escape(filePath)}"]`);
    if (fileEl) {
      fileEl.classList.add('active');
      // Expand parent folders
      let parent = fileEl.parentElement;
      while (parent) {
        if (parent.classList?.contains('tree-children')) {
          parent.classList.add('expanded');
          const chevron = parent.previousElementSibling?.querySelector('.chevron');
          if (chevron) chevron.classList.add('open');
        }
        parent = parent.parentElement;
      }
    }

    // Show loading
    welcomeScreen.style.display = 'none';
    docView.style.display = 'flex';
    markdownBody.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    // Set breadcrumb
    const parts = filePath.split('/');
    breadcrumbEl.innerHTML = parts
      .map((p, i) => {
        const cls = i === parts.length - 1 ? 'current' : '';
        return `<span class="${cls}">${p}</span>`;
      })
      .join('<span class="sep">/</span>');

    // Fetch content — encode each path segment individually to preserve slashes
    const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
    const res = await fetch(`/api/file/${encodedPath}`);
    const content = await res.text();

    // Determine rendering
    const ext = filePath.split('.').pop();
    if (ext === 'json') {
      renderJson(content);
    } else {
      renderMarkdown(content);
    }

    // Scroll to top
    markdownBody.scrollTop = 0;
  }

  function renderJson(content) {
    let formatted;
    try {
      formatted = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      formatted = content;
    }

    const highlighted = (typeof hljs !== 'undefined')
      ? hljs.highlight(formatted, { language: 'json' }).value
      : escapeHtml(formatted);
    markdownBody.innerHTML = `<div class="json-viewer"><pre><code>${highlighted}</code></pre></div>`;
    tocList.innerHTML = '';
  }

  async function renderMarkdown(content) {
    mermaidIdCounter = 0;
    const html = marked.parse(content);
    markdownBody.innerHTML = html;

    // Render mermaid diagrams
    try {
      const mermaidEls = markdownBody.querySelectorAll('.mermaid');
      for (const el of mermaidEls) {
        const id = el.id || `mermaid-auto-${Math.random().toString(36).slice(2)}`;
        el.id = id;
        const source = el.textContent;
        try {
          const { svg } = await mermaid.render(id + '-svg', source);
          el.innerHTML = svg;

          // Add expand button to the container
          const container = el.closest('.mermaid-container');
          if (container) {
            const expandBtn = document.createElement('button');
            expandBtn.className = 'mermaid-expand-btn';
            expandBtn.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="15 3 21 3 21 9"></polyline>
                <polyline points="9 21 3 21 3 15"></polyline>
                <line x1="21" y1="3" x2="14" y2="10"></line>
                <line x1="3" y1="21" x2="10" y2="14"></line>
              </svg>
              Fullscreen
            `;
            expandBtn.addEventListener('click', () => openMermaidModal(el.innerHTML));
            container.appendChild(expandBtn);
          }
        } catch (err) {
          el.innerHTML = `<pre style="color: var(--text-red); font-size: 12px;">Mermaid render error:\n${escapeHtml(err.message || String(err))}</pre>`;
        }
      }
    } catch (_) { /* swallow */ }

    // Build ToC
    buildToc();
  }

  // ─── Mermaid Fullscreen Modal with Zoom/Pan ───
  let modalState = { zoom: 1, panX: 0, panY: 0, dragging: false, startX: 0, startY: 0 };

  function openMermaidModal(svgHtml) {
    // Reset state
    modalState = { zoom: 1, panX: 0, panY: 0, dragging: false, startX: 0, startY: 0 };

    const overlay = document.createElement('div');
    overlay.className = 'mermaid-modal-overlay';
    overlay.innerHTML = `
      <div class="mermaid-modal">
        <div class="mermaid-modal-toolbar">
          <div class="modal-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            Diagram Viewer
          </div>
          <div class="modal-controls">
            <button class="modal-ctrl-btn" data-action="zoom-out" title="Zoom Out (−)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            <span class="modal-zoom-label">100%</span>
            <button class="modal-ctrl-btn" data-action="zoom-in" title="Zoom In (+)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            <div class="modal-ctrl-sep"></div>
            <button class="modal-ctrl-btn" data-action="fit" title="Fit to Screen (F)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
              </svg>
              Fit
            </button>
            <button class="modal-ctrl-btn" data-action="reset" title="Reset (R)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10"></polyline>
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
              </svg>
              Reset
            </button>
            <div class="modal-ctrl-sep"></div>
            <button class="modal-close-btn" data-action="close" title="Close (Esc)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
        <div class="mermaid-modal-viewport">
          <div class="mermaid-modal-canvas">${svgHtml}</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const viewport = overlay.querySelector('.mermaid-modal-viewport');
    const canvas = overlay.querySelector('.mermaid-modal-canvas');
    const zoomLabel = overlay.querySelector('.modal-zoom-label');

    function updateTransform() {
      canvas.style.transform = `translate(${modalState.panX}px, ${modalState.panY}px) scale(${modalState.zoom})`;
      zoomLabel.textContent = `${Math.round(modalState.zoom * 100)}%`;
    }

    function setZoom(newZoom, centerX, centerY) {
      const clampedZoom = Math.max(0.1, Math.min(5, newZoom));
      if (centerX !== undefined && centerY !== undefined) {
        // Zoom toward cursor position
        const ratio = clampedZoom / modalState.zoom;
        modalState.panX = centerX - ratio * (centerX - modalState.panX);
        modalState.panY = centerY - ratio * (centerY - modalState.panY);
      }
      modalState.zoom = clampedZoom;
      updateTransform();
    }

    function fitToScreen() {
      const svgEl = canvas.querySelector('svg');
      if (!svgEl) return;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const sw = svgEl.getBoundingClientRect().width / modalState.zoom || svgEl.viewBox?.baseVal?.width || 800;
      const sh = svgEl.getBoundingClientRect().height / modalState.zoom || svgEl.viewBox?.baseVal?.height || 600;
      const scale = Math.min((vw - 60) / sw, (vh - 60) / sh, 2);
      modalState.zoom = scale;
      modalState.panX = (vw - sw * scale) / 2;
      modalState.panY = (vh - sh * scale) / 2;
      updateTransform();
    }

    function resetView() {
      modalState.zoom = 1;
      modalState.panX = 0;
      modalState.panY = 0;
      updateTransform();
    }

    function closeModal() {
      overlay.remove();
      document.removeEventListener('keydown', handleModalKeys);
    }

    // Button actions
    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) {
        // Click on overlay background to close
        if (e.target === overlay) closeModal();
        return;
      }
      const action = btn.dataset.action;
      if (action === 'zoom-in') setZoom(modalState.zoom + 0.2);
      else if (action === 'zoom-out') setZoom(modalState.zoom - 0.2);
      else if (action === 'fit') fitToScreen();
      else if (action === 'reset') resetView();
      else if (action === 'close') closeModal();
    });

    // Mouse wheel zoom
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(modalState.zoom + delta * modalState.zoom, cx, cy);
    }, { passive: false });

    // Mouse drag panning
    viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      modalState.dragging = true;
      modalState.startX = e.clientX - modalState.panX;
      modalState.startY = e.clientY - modalState.panY;
      viewport.classList.add('grabbing');
    });

    document.addEventListener('mousemove', function onMove(e) {
      if (!modalState.dragging) return;
      modalState.panX = e.clientX - modalState.startX;
      modalState.panY = e.clientY - modalState.startY;
      updateTransform();
    });

    document.addEventListener('mouseup', function onUp() {
      modalState.dragging = false;
      viewport.classList.remove('grabbing');
    });

    // Keyboard shortcuts
    function handleModalKeys(e) {
      if (e.key === 'Escape') closeModal();
      else if (e.key === '+' || e.key === '=') setZoom(modalState.zoom + 0.2);
      else if (e.key === '-') setZoom(modalState.zoom - 0.2);
      else if (e.key === 'f' || e.key === 'F') fitToScreen();
      else if (e.key === 'r' || e.key === 'R') resetView();
      else if (e.key === '0') { modalState.zoom = 1; modalState.panX = 0; modalState.panY = 0; updateTransform(); }
    }
    document.addEventListener('keydown', handleModalKeys);

    // Initial fit
    requestAnimationFrame(() => fitToScreen());
  }

  function buildToc() {
    const headings = markdownBody.querySelectorAll('h1, h2, h3, h4');
    tocList.innerHTML = '';

    headings.forEach((h, i) => {
      const id = `heading-${i}`;
      h.id = id;

      const link = document.createElement('a');
      link.href = `#${id}`;
      link.textContent = h.textContent;
      link.className = `toc-${h.tagName.toLowerCase()}`;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      tocList.appendChild(link);
    });
  }

  // ─── ToC toggle ───
  btnToc.addEventListener('click', () => {
    tocVisible = !tocVisible;
    tocPanel.classList.toggle('visible', tocVisible);
    btnToc.classList.toggle('active', tocVisible);
  });

  // Start with ToC visible
  tocPanel.classList.add('visible');
  btnToc.classList.add('active');

  // ─── Search / filter ───
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    const allFiles = document.querySelectorAll('.tree-file');
    const allFolders = document.querySelectorAll('.tree-folder');

    if (!q) {
      allFiles.forEach(f => (f.style.display = ''));
      allFolders.forEach(f => (f.style.display = ''));
      return;
    }

    // Hide all first, then show matches + their parents
    allFiles.forEach(f => (f.style.display = 'none'));
    allFolders.forEach(f => (f.style.display = 'none'));

    allFiles.forEach(f => {
      const path = (f.dataset.path || '').toLowerCase();
      if (path.includes(q)) {
        f.style.display = '';
        // Show parent folders
        let parent = f.parentElement;
        while (parent && parent !== fileTreeEl) {
          if (parent.classList?.contains('tree-folder')) {
            parent.style.display = '';
          }
          if (parent.classList?.contains('tree-children')) {
            parent.classList.add('expanded');
            const chevron = parent.previousElementSibling?.querySelector('.chevron');
            if (chevron) chevron.classList.add('open');
          }
          parent = parent.parentElement;
        }
      }
    });
  });

  // ─── Keyboard shortcut ───
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + K to focus search
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ─── Hash-based routing ───
  function getFileFromHash() {
    const hash = window.location.hash;
    if (hash.startsWith('#file=')) {
      return decodeURIComponent(hash.slice('#file='.length));
    }
    return null;
  }

  window.addEventListener('hashchange', () => {
    const filePath = getFileFromHash();
    if (filePath && filePath !== currentPath) {
      loadFile(filePath, true, true);
    }
  });

  window.addEventListener('popstate', () => {
    const filePath = getFileFromHash();
    if (filePath && filePath !== currentPath) {
      loadFile(filePath, true, true);
    } else if (!filePath) {
      // Back to welcome screen
      currentPath = null;
      welcomeScreen.style.display = '';
      docView.style.display = 'none';
      document.querySelectorAll('.tree-file.active').forEach(el => el.classList.remove('active'));
    }
  });

  // ─── Init ───
  async function init() {
    await loadTree();
    // Restore file from URL hash after tree is built
    const hashFile = getFileFromHash();
    if (hashFile) {
      loadFile(hashFile, true, true);
    }
  }
  init();
})();

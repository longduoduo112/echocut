const state = {
    contents: [],
    selectedId: null,
    activeView: 'overview',
    statusFilter: 'all',
    configs: [],
    files: {
        audio_inputs: [],
        video_inputs: [],
        incoming_files: [],
        generated_videos: [],
        logs: [],
        transcribe_json: [],
        debug_audio: [],
        debug_video: [],
        debug_text: []
    },
    layoutPreviewDrag: null,
    layoutPreviewPointerBound: false,
    layoutCommand: {
        mode: 'single',
        engine: 'sensevoice',
        previewSeconds: 18,
        videoFile: '',
        targetDir: 'testvideos/测试视频-01-读书学语言'
    }
};

// --- Utils ---
function qs(id) {
    return document.getElementById(id);
}

function toast(message, type = 'info') {
    const el = qs('toast');
    if (!el) return;
    
    // Icon based on type
    let icon = '';
    if (type === 'success') icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    else if (type === 'error') icon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

    el.innerHTML = `${icon}<span>${message}</span>`;
    el.className = `toast-capsule visible ${type}`;
    
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => {
        el.classList.remove('visible');
    }, 3000);
}

function setRegenerateBusy(busy) {
    const btnAll = qs('regenAllBtn');
    const btnMoments = qs('regenMomentsBtn');
    const btnArticle = qs('regenArticleBtn');
    const btnVideo = qs('regenVideoBtn');

    if (!btnAll) return;
    
    // Only disable if explicitly busy (processing)
    // If not busy, we enable them so user can re-generate anytime
    if (busy) {
        [btnAll, btnMoments, btnArticle, btnVideo].forEach(btn => {
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span class="spinner-small"></span> 处理中...';
            }
        });
    } else {
        [btnAll, btnMoments, btnArticle, btnVideo].forEach(btn => {
            if (btn) btn.disabled = false;
        });
    }
}

async function api(path, options = {}) {
    try {
        const res = await fetch(path, {
            headers: { 'Content-Type': 'application/json' },
            ...options
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(text || `HTTP ${res.status}`);
        }
        return res.json();
    } catch (err) {
        toast(err.message, 'error');
        throw err;
    }
}

// --- Renderers ---

function statusBadge(status) {
    const map = {
        'published': 'published',
        'reviewing': 'reviewing',
        'pending': 'pending',
        'processing': 'processing'
    };
    const labelMap = {
        'published': 'Published',
        'reviewing': 'Ready',
        'pending': 'Pending',
        'processing': 'Processing'
    };
    const s = map[status] || 'pending';
    return `<span class="status-badge ${s}">${labelMap[status] || 'Unknown'}</span>`;
}

function renderStats(data) {
    const stats = qs('stats');
    if (!stats) return;
    stats.innerHTML = `
        <div class="stat-box">
            <div class="stat-label">TOTAL</div>
            <div class="stat-value">${data.total}</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">PROCESSING</div>
            <div class="stat-value" style="color:var(--orange)">${data.processing}</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">READY</div>
            <div class="stat-value" style="color:var(--blue)">${data.generated}</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">PUBLISHED</div>
            <div class="stat-value" style="color:var(--green)">${data.published}</div>
        </div>
    `;
}

function renderList(preserveScroll = false) {
    const list = qs('contentList');
    if (!list) return;

    const rows = state.contents.filter((item) => (
        state.statusFilter === 'all' ? true : item.status === state.statusFilter
    ));

    // Simple diff to avoid full re-render if not needed could be complex, 
    // but for now let's just optimize the selection update.
    // If we are just updating selection, we shouldn't be calling renderList ideally.
    // But since we are here, let's rebuild.

    const scrollPos = list.scrollTop;

    if (!rows.length) {
        list.innerHTML = `
            <div class="empty-state" style="padding: 40px 0;">
                <div class="empty-icon">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
                </div>
                <p>暂无内容</p>
            </div>`;
        return;
    }

    list.innerHTML = rows.map((item) => {
        const sourceBadge = item.source === 'cli'
            ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:var(--surface-3);color:var(--text-tertiary);font-family:var(--font-mono);">CLI</span>`
            : '';
        const title = item.headline || (item.raw_text || '无标题内容').replace(/\s+/g, ' ').slice(0, 60);
        return `
        <div class="list-item ${state.selectedId === item.id ? 'active' : ''}" data-id="${item.id}">
            <div class="item-top">
                <span>#${item.id} ${sourceBadge}</span>
                <span>${item.created_at ? new Date(item.created_at).toLocaleDateString() : '--'}</span>
            </div>
            <div class="item-title">${title}</div>
            <div style="margin-top: 6px;">
                ${statusBadge(item.status)}
            </div>
        </div>
    `}).join('');

    list.querySelectorAll('.list-item').forEach((el) => {
        el.addEventListener('click', () => {
            const id = Number(el.dataset.id);
            state.selectedId = id;
            updateListSelection();
            openContent(id);
        });
    });

    if (preserveScroll) {
        list.scrollTop = scrollPos;
    }
}

function updateListSelection() {
    document.querySelectorAll('#contentList .list-item').forEach(el => {
        const id = Number(el.dataset.id);
        if (id === state.selectedId) {
            el.classList.add('active');
        } else {
            el.classList.remove('active');
        }
    });
}

function findVideoForContent(item) {
    if (item.video_output_path) return item.video_output_path;
    const audioPath = item.audio_path || '';
    const stem = audioPath ? audioPath.split('/').pop().replace(/\.[^.]+$/, '') : '';
    const idStem = `content_${item.id}`;

    const videos = [
        ...(Array.isArray(state.files.generated_videos) ? state.files.generated_videos : []),
        ...(Array.isArray(state.files.debug_video) ? state.files.debug_video : [])
    ];
    const found = videos.find((row) => {
        if (!/\.(mp4|m4v|webm|mov)$/i.test(row.name)) return false;
        if (stem && row.rel_path.includes(stem)) return true;
        if (row.name.includes(idStem)) return true;
        return false;
    });
    return found ? found.abs_path : '';
}

function streamUrl(absPath) {
    return `/admin/api/file-stream?path=${encodeURIComponent(absPath)}`;
}

function renderShowcase() {
    const textWrap = qs('resultTextCards');
    const videoWrap = qs('resultVideoCards');
    if (!textWrap || !videoWrap) return;
    
    // Text Showcase
    const textRows = state.contents.slice(0, 5);
    if (!textRows.length) {
        textWrap.innerHTML = '<div class="empty-state"><p>No content yet</p></div>';
    } else {
        textWrap.innerHTML = textRows.map((item) => `
            <div class="result-card" onclick="switchView('content'); state.selectedId=${item.id}; openContent(${item.id}); updateListSelection();">
                <div class="item-top">
                    <span class="id-badge">#${item.id}</span>
                    ${statusBadge(item.status)}
                </div>
                <div style="margin-top: 10px; font-size: 13px; color: var(--text-primary); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;">
                    ${(item.draft_article || item.raw_text || 'Empty').slice(0, 200)}
                </div>
                <div style="margin-top: 8px; font-size: 12px; color: var(--text-tertiary);">
                    ${item.created_at ? new Date(item.created_at).toLocaleString() : '--'}
                </div>
            </div>
        `).join('');
    }

    // Video Showcase
    const videoRows = state.contents
        .map((item) => ({ item, videoPath: findVideoForContent(item) }))
        .filter((x) => x.videoPath)
        .slice(0, 4);

    if (!videoRows.length) {
        videoWrap.innerHTML = '<div class="empty-state"><p>No videos yet</p></div>';
    } else {
        videoWrap.innerHTML = videoRows.map(({ item, videoPath }) => `
            <div class="result-card" onclick="switchView('content'); state.selectedId=${item.id}; openContent(${item.id}); updateListSelection();">
                <div class="item-top">
                    <span class="id-badge">#${item.id}</span>
                    ${statusBadge(item.status)}
                </div>
                <div style="margin-top: 10px; border-radius: var(--radius-m); overflow: hidden; background: #000;">
                    <video controls preload="metadata" src="${streamUrl(videoPath)}" style="width: 100%; max-height: 280px; display: block;"></video>
                </div>
                <div style="margin-top: 8px; font-size: 11px; color: var(--text-tertiary); font-family: var(--font-mono);">
                    ${videoPath.split('/').pop()}
                </div>
            </div>
        `).join('');
    }
}

// --- Actions ---

async function loadSummary() {
    try {
        const data = await api('/admin/api/summary');
        renderStats(data);
    } catch (e) { console.error(e); }
}

async function loadContents() {
    try {
        const list = await api('/admin/api/contents');
        state.contents = list;
        
        // Pre-fetch video files to ensure showcase renders correctly
        // We fire and forget this, or await if we want to be strict. 
        // Await is safer to ensure findVideoForContent works immediately.
        try {
            const filesRes = await api('/admin/api/files');
            if (filesRes.debug_video) {
                state.files.debug_video = filesRes.debug_video;
            }
        } catch (err) {
            console.warn('Failed to pre-fetch video files', err);
        }

        renderList(true);
        renderShowcase();

        // Refresh detail view if open
        if (state.selectedId && state.activeView === 'content') {
             openContent(state.selectedId);
        }
    } catch (e) { console.error(e); }
}

async function openContent(id) {
    const item = state.contents.find(x => x.id === id);
    if (!item) return;

    qs('editorEmpty').classList.add('hidden');
    qs('editorForm').classList.remove('hidden');

    // Populate Fields
    qs('displayId').textContent = `#${item.id}`;
    qs('displayStatus').innerHTML = statusBadge(item.status); // Use HTML for badge
    qs('displayTime').textContent = new Date(item.created_at).toLocaleString();
    
    qs('editId').value = item.id;
    qs('editStatusLabel').value = item.status;
    qs('editAudioPath').value = item.audio_path || '';
    qs('editTranscribePath').value = item.transcribe_json_path || '';
    qs('editVideoPath').value = item.video_output_path || '';

    // Show headline/subline for CLI-generated video entries
    const metaRow = qs('videoMetadataRow');
    if (metaRow) {
        const headline = (item.headline || '').trim();
        const subline = (item.subline || '').trim();
        if (headline || subline) {
            metaRow.style.display = 'block';
            if (qs('displayHeadline')) qs('displayHeadline').textContent = headline;
            if (qs('displaySubline')) qs('displaySubline').textContent = subline;
        } else {
            metaRow.style.display = 'none';
        }
    }
    
    qs('editRawText').value = item.raw_text || '';
    qs('editDraft').value = item.draft_article || '';
    qs('editHook').value = item.hook_moment || '';
    qs('editTrace').value = item.process_trace || '';
    renderContentResultPreview(item);

    // Video preview
    const videoPath = findVideoForContent(item);
    const vpSection = qs('videoPreviewSection');
    const vpPlayer = qs('videoPreviewPlayer');
    if (videoPath && vpSection && vpPlayer) {
        vpSection.style.display = 'block';
        vpPlayer.src = streamUrl(videoPath);
    } else if (vpSection) {
        vpSection.style.display = 'none';
    }

    // Always enable regeneration buttons unless currently processing
    const isProcessing = item.status === 'pending' || item.status === 'processing';
    setRegenerateBusy(isProcessing);
    
    // Update button text based on status to indicate "Re-generate"
    const btnAll = qs('regenAllBtn');
    const btnMoments = qs('regenMomentsBtn');
    const btnArticle = qs('regenArticleBtn');
    const btnVideo = qs('regenVideoBtn');
    
    if (btnAll) {
        btnAll.disabled = isProcessing;
        btnAll.className = `action-btn ${isProcessing ? 'secondary' : 'primary'}`;
        btnAll.innerHTML = isProcessing 
            ? '<span class="spinner-small"></span> 处理中...' 
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"></path><path d="M23 20v-6h-6"></path><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"></path></svg> 重新生成全部';
    }
    
    if (btnMoments) {
        btnMoments.disabled = isProcessing;
        btnMoments.innerHTML = isProcessing 
            ? '<span class="spinner-small"></span> 处理中...' 
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"></path><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg> 重试朋友圈';
    }

    if (btnArticle) {
        btnArticle.disabled = isProcessing;
        btnArticle.innerHTML = isProcessing 
            ? '<span class="spinner-small"></span> 处理中...' 
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg> 重试文案';
    }

    if (btnVideo) {
        btnVideo.disabled = isProcessing;
        btnVideo.innerHTML = isProcessing
            ? '<span class="spinner-small"></span> 处理中...'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg> 重试视频';
    }

    // Show reset button only for stuck pending items
    let resetBtn = qs('resetPendingBtn');
    if (!resetBtn) {
        resetBtn = document.createElement('button');
        resetBtn.id = 'resetPendingBtn';
        resetBtn.type = 'button';
        resetBtn.className = 'action-btn secondary';
        resetBtn.style.marginTop = '8px';
        const actionGroup = btnAll?.closest('.action-group') || btnAll?.parentElement;
        if (actionGroup) actionGroup.appendChild(resetBtn);
    }
    if (item.status === 'pending') {
        resetBtn.style.display = '';
        resetBtn.textContent = '⚠ 标记为可查看';
        resetBtn.onclick = () => window.resetPending(item.id);
    } else {
        resetBtn.style.display = 'none';
    }
}

async function saveContent(e) {
    e.preventDefault();
    const id = Number(qs('editId').value);
    const body = {
        raw_text: qs('editRawText').value,
        draft_article: qs('editDraft').value,
        hook_moment: qs('editHook').value
    };

    try {
        await api(`/admin/api/contents/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(body)
        });
        toast('Saved', 'success');
        loadContents(); // Refresh
    } catch (err) {
        // Handled by api()
    }
}

function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ 已复制';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
}

function renderPublishKitCards(publishKitJson) {
    let groups = [];
    try { groups = JSON.parse(publishKitJson || '[]'); } catch (_) {}
    if (!Array.isArray(groups) || groups.length === 0) return '';
    const NUMS = ['一', '二', '三', '四'];
    const cards = groups.map((g, i) => {
        const num = NUMS[i] || String(i + 1);
        const title = String(g.title || '');
        const desc = String(g.description || '');
        const copyText = `${title}\n\n${desc}`;
        return `
        <div style="border:1px solid var(--border);border-radius:var(--radius-m);padding:14px;background:var(--surface-2);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-size:12px;font-weight:600;color:var(--text-secondary);">组${num}</span>
                <button onclick="copyToClipboard(${JSON.stringify(copyText)}, this)" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);color:var(--text-secondary);cursor:pointer;">复制</button>
            </div>
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">${title}</div>
            <div style="font-size:12px;color:var(--text-secondary);white-space:pre-wrap;line-height:1.6;">${desc}</div>
        </div>`;
    });
    return `
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
            <span>宣发素材包 (${groups.length} 组)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;">${cards.join('')}</div>`;
}

function renderContentResultPreview(item) {
    const wrap = qs('contentResultPreview');
    if (!wrap) return;
    const videoPath = findVideoForContent(item);
    const rawText = (item.raw_text || '').trim();
    const draft = (item.draft_article || '').trim();
    const hook = (item.hook_moment || '').trim();
    const headline = (item.headline || '').trim();
    const subline = (item.subline || '').trim();
    const publishKit = renderPublishKitCards(item.publish_kit_json || '[]');

    const metaRow = (headline || subline) ? `
        <div>
            <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:6px;">Video Metadata</div>
            <div style="display:flex;flex-direction:column;gap:4px;">
                ${headline ? `<div style="font-size:14px;font-weight:700;color:var(--text-primary);">${headline}</div>` : ''}
                ${subline ? `<div style="font-size:12px;color:var(--text-secondary);">${subline}</div>` : ''}
            </div>
        </div>` : '';

    const publishRow = publishKit ? `
        <div>
            ${publishKit}
        </div>` : '';

    wrap.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:14px;">
            ${metaRow}
            ${publishRow}
            <div>
                <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span>Raw Text</span>
                    ${rawText ? `<button onclick="copyToClipboard(${JSON.stringify(rawText)}, this)" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);color:var(--text-secondary);cursor:pointer;">复制</button>` : ''}
                </div>
                <div class="code-block" style="white-space:pre-wrap;">${rawText || 'N/A'}</div>
            </div>
            <div>
                <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span>Article</span>
                    ${draft ? `<button onclick="copyToClipboard(${JSON.stringify(draft)}, this)" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);color:var(--text-secondary);cursor:pointer;">复制</button>` : ''}
                </div>
                <div class="code-block" style="white-space:pre-wrap;">${draft || 'Not generated'}</div>
            </div>
            <div>
                <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
                    <span>Moments Copy</span>
                    ${hook ? `<button onclick="copyToClipboard(${JSON.stringify(hook)}, this)" style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-3);color:var(--text-secondary);cursor:pointer;">复制</button>` : ''}
                </div>
                <div class="code-block" style="white-space:pre-wrap;">${hook || 'Not generated'}</div>
            </div>
            <div>
                <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:6px;">Video Output</div>
                ${videoPath ? `<video controls preload="metadata" src="${streamUrl(videoPath)}" style="width:100%; max-height:320px; border-radius:10px; background:#000;"></video>` : '<div class="code-block">No video</div>'}
            </div>
        </div>
    `;
}

async function regenerate(mode) {
    const id = Number(qs('editId').value);
    if (!id) return;

    setRegenerateBusy(true);
    try {
        await api(`/admin/api/contents/${id}/regenerate`, {
            method: 'POST',
            body: JSON.stringify({ mode })
        });
        toast('Task submitted', 'success');
        // Poll or just refresh after a delay? For now just refresh immediately to show status change if any
        setTimeout(loadContents, 1000);
    } catch (err) {
        // Handled
    } finally {
        setRegenerateBusy(false);
    }
}

// --- View Switching ---

function switchView(viewName) {
    if (state.activeView === viewName) return;

    const oldView = qs(`view-${state.activeView}`);
    const newView = qs(`view-${viewName}`);
    
    state.activeView = viewName;
    
    // Update Nav
    document.querySelectorAll('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update Title
    const titles = {
        'overview': 'Studio',
        'content': 'Content',
        'upload': 'Upload',
        'prompts': 'Config',
        'assets': 'Files'
    };
    qs('pageTitle').textContent = titles[viewName] || 'Echo Studio';

    // Transition
    if (oldView) {
        oldView.classList.remove('active');
        setTimeout(() => {
            if (!oldView.classList.contains('active')) {
                oldView.classList.add('hidden');
            }
        }, 400); // Match CSS transition
    }

    if (newView) {
        newView.classList.remove('hidden');
        // Force reflow
        void newView.offsetWidth; 
        newView.classList.add('active');
    }

    // Load data based on view
    if (viewName === 'overview') {
        loadSummary();
        loadContents();
    } else if (viewName === 'content') {
        loadContents();
    } else if (viewName === 'prompts') {
        loadPrompts();
    } else if (viewName === 'assets') {
        loadFiles();
    }
}

// --- Configs / Prompts ---

async function loadPrompts() {
    try {
        const configs = await api('/admin/api/configs');
        state.configs = configs;
        renderPrompts();
    } catch (e) { console.error(e); }
}

const VIDEO_CONFIG_SCHEMA = {
    video_caption_keywords: { label: '关键词高亮词库', type: 'textarea', rows: 4, hint: '用逗号分隔，例如：重要,关键,增长,突破' },
    video_caption_highlight_color: { label: '高亮颜色', type: 'color' },
    video_caption_subtitle_color: { label: '字幕颜色', type: 'color' },
    video_caption_subtitle_outline_color: { label: '字幕描边颜色', type: 'color' },
    video_caption_enable_emphasis: { label: '启用关键词高亮', type: 'boolean' },
    video_caption_semantic_break: { label: '语义分句（标点强制断句）', type: 'boolean' },
    video_caption_subtitle_offset_ms: { label: '字幕时间偏移(ms)', type: 'number', min: -2000, max: 2000, step: 50, fixed: 0, fallback: 0 },
    video_caption_subtitle_align: {
        label: '字幕对齐方式',
        type: 'select',
        options: [
            { value: 'left', label: '左对齐' },
            { value: 'center', label: '居中' },
            { value: 'right', label: '右对齐' }
        ]
    },
    video_caption_subtitle_margin_h: { label: '字幕左右边距(px)', type: 'number', min: 12, max: 180, step: 1, fixed: 0, fallback: 36 },
    video_caption_subtitle_margin_v: { label: '字幕底部边距(px)', type: 'number', min: 16, max: 180, step: 1, fixed: 0, fallback: 42 },
    video_caption_cjk_term_max_chars: { label: '中文词语最大字数', type: 'number', min: 2, max: 8, step: 1, fixed: 0, fallback: 4 },
    video_caption_chunk_max_chars: { label: '单条字幕最大字符', type: 'number', min: 6, max: 36, step: 1, fixed: 0, fallback: 14 },
    video_caption_chunk_max_duration: { label: '单条字幕最长时长(秒)', type: 'number', min: 0.5, max: 4.5, step: 0.05, fixed: 2, fallback: 1.75 },
    video_caption_chunk_gap_break_sec: { label: '分句静默阈值(秒)', type: 'number', min: 0.05, max: 1.5, step: 0.01, fixed: 2, fallback: 0.45 },
    video_caption_cjk_gap_break_sec: { label: '中文合词间隔阈值(秒)', type: 'number', min: 0.05, max: 1.5, step: 0.01, fixed: 2, fallback: 0.36 },
    video_caption_latin_gap_break_sec: { label: '英文合词间隔阈值(秒)', type: 'number', min: 0.02, max: 1.5, step: 0.01, fixed: 2, fallback: 0.18 },
    video_layout_target_w: { label: '容器宽度', type: 'number', min: 540, max: 2160, step: 1, fixed: 0, fallback: 1080 },
    video_layout_target_h: { label: '容器高度', type: 'number', min: 960, max: 3840, step: 1, fixed: 0, fallback: 1920 },
    video_layout_crop_scale: { label: '视频裁剪放大倍数', type: 'number', min: 1, max: 1.4, step: 0.01, fixed: 2, fallback: 1.15 },
    video_layout_crop_offset_y: { label: '裁剪纵向偏移', type: 'number', min: 0, max: 0.5, step: 0.01, fixed: 2, fallback: 0.15 },
    video_layout_treat_square_as_video_note: { label: '方形视频走 Video Note 模板', type: 'boolean' },
    video_layout_treat_vertical_as_video_note: { label: '竖屏视频走 Video Note 模板', type: 'boolean' },
    video_layout_top_band_ratio: { label: '顶部黑边比例', type: 'number', min: 0.08, max: 0.32, step: 0.01, fixed: 2, fallback: 0.2 },
    video_layout_bottom_band_ratio: { label: '底部黑边比例', type: 'number', min: 0.08, max: 0.4, step: 0.01, fixed: 2, fallback: 0.22 },
    video_layout_headline_font_size: { label: '主标题字号', type: 'number', min: 28, max: 140, step: 1, fixed: 0, fallback: 96 },
    video_layout_subline_font_size: { label: '副标题字号', type: 'number', min: 18, max: 88, step: 1, fixed: 0, fallback: 54 },
    video_layout_subtitle_font_size: { label: '字幕字号', type: 'number', min: 12, max: 42, step: 1, fixed: 0, fallback: 16 },
    video_layout_title_offset_y: { label: '标题整体纵向偏移(px)', type: 'number', min: -220, max: 220, step: 1, fixed: 0, fallback: 0 },
    video_layout_subtitle_offset_y: { label: '字幕纵向偏移(px)', type: 'number', min: -220, max: 220, step: 1, fixed: 0, fallback: 0 }
};

const ASR_CONFIG_SCHEMA = {
    asr_domain_keywords: { label: '转写专词库', type: 'textarea', rows: 6, hint: '逗号分隔专有名词，如：王阳明,DeepSeek,知行合一。保存后立即生效，影响所有转写引擎的识别准确率。' }
};

function normalizeConfigValue(key, value) {
    const schema = VIDEO_CONFIG_SCHEMA[key] || ASR_CONFIG_SCHEMA[key];
    const text = String(value ?? '');
    if (!schema) return text;
    if (schema.type === 'boolean') {
        return ['1', 'true', 'yes', 'on'].includes(text.trim().toLowerCase()) ? '1' : '0';
    }
    if (schema.type === 'color') {
        const color = text.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toUpperCase();
        if (key === 'video_caption_subtitle_color') return '#F2F4F8';
        if (key === 'video_caption_subtitle_outline_color') return '#0F172A';
        return '#FFD54F';
    }
    if (schema.type === 'select') {
        const options = Array.isArray(schema.options) ? schema.options : [];
        const picked = text.trim().toLowerCase();
        const valid = options.find((opt) => opt.value === picked);
        return valid ? valid.value : (options[0]?.value || '');
    }
    if (schema.type === 'number') {
        const n = Number(text);
        const safe = Number.isFinite(n) ? Math.min(schema.max, Math.max(schema.min, n)) : schema.fallback;
        return schema.fixed > 0 ? safe.toFixed(schema.fixed) : String(Math.round(safe));
    }
    if (key === 'video_caption_keywords') {
        return text
            .split(/[\n,，、;；|]/g)
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 80)
            .join(',');
    }
    if (key === 'asr_domain_keywords') {
        const seen = new Set();
        return text
            .split(/[\n,，、;；]/g)
            .map((x) => x.trim())
            .filter((x) => { if (!x || seen.has(x)) return false; seen.add(x); return true; })
            .join(',');
    }
    return text;
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function shellQuote(text) {
    const raw = String(text ?? '');
    if (!raw) return '""';
    return `"${raw.replace(/(["\\$`])/g, '\\$1')}"`;
}

function getConfigNum(configMap, key, fallback) {
    const value = Number(configMap[key] ?? fallback);
    return Number.isFinite(value) ? value : fallback;
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function weightedTextUnits(text) {
    let units = 0;
    for (const ch of String(text || '')) {
        if (!ch.trim()) continue;
        units += /[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch) ? 1 : 0.58;
    }
    return units;
}

function fitTextFontSizeByWidth(text, currentSize, maxWidthPx, minSize) {
    const units = Math.max(1, weightedTextUnits(text));
    const fitSize = Math.floor((maxWidthPx / units) * 0.92);
    return Math.max(minSize, Math.min(currentSize, fitSize));
}

function resolveStylePresetByPreviewType(videoType) {
    if (videoType === 'vertical') return 'vertical';
    if (videoType === 'square') return 'square';
    if (videoType === 'landscape') return 'landscape';
    return 'safe';
}

function buildLayoutCommands(configMap, videoType) {
    const cmd = state.layoutCommand || {};
    const mode = cmd.mode === 'batch' ? 'batch' : 'single';
    const engine = String(cmd.engine || 'sensevoice').trim() || 'sensevoice';
    const previewSeconds = Math.max(0, Number(cmd.previewSeconds || 0));
    const preset = resolveStylePresetByPreviewType(videoType);
    const headlineSize = Math.round(getConfigNum(configMap, 'video_layout_headline_font_size', 96));
    const sublineSize = Math.round(getConfigNum(configMap, 'video_layout_subline_font_size', 54));
    const subtitleSize = Math.round(getConfigNum(configMap, 'video_layout_subtitle_font_size', 16));
    const marginV = Math.round(getConfigNum(configMap, 'video_caption_subtitle_margin_v', 42));
    const marginH = Math.round(getConfigNum(configMap, 'video_caption_subtitle_margin_h', 36));
    const sentenceMaxChars = Math.round(getConfigNum(configMap, 'video_caption_sentence_max_chars', 18));
    const chunkMaxChars = Math.round(getConfigNum(configMap, 'video_caption_chunk_max_chars', 14));
    const previewArg = previewSeconds > 0 ? ` --preview-seconds=${previewSeconds}` : '';
    if (mode === 'batch') {
        const targetDir = String(cmd.targetDir || 'testvideos/测试视频-01-读书学语言').trim() || 'testvideos/测试视频-01-读书学语言';
        return `ENGINES=${engine} STYLE_PRESET=${preset} STYLE_HEADLINE_SIZE=${headlineSize} STYLE_SUBLINE_SIZE=${sublineSize} STYLE_SUBTITLE_SIZE=${subtitleSize} STYLE_SUBTITLE_MARGIN_V=${marginV} STYLE_SUBTITLE_MARGIN_H=${marginH} SENTENCE_MAX_CHARS=${sentenceMaxChars} CHUNK_MAX_CHARS=${chunkMaxChars} SUBTITLE_MAX_UNITS=12 PREVIEW_SECONDS=${previewSeconds} TARGET_DIR=${shellQuote(targetDir)} ./testvideos/process-01-batch.sh`;
    }
    const videoFile = String(cmd.videoFile || '').trim() || '/absolute/path/to/video.mp4';
    return `node scripts/run-video-cases.js --engine=${engine} --video-file=${shellQuote(videoFile)} --style-preset=${preset} --headline-font-size=${headlineSize} --subline-font-size=${sublineSize} --subtitle-font-size=${subtitleSize} --subtitle-margin-v=${marginV} --subtitle-margin-h=${marginH} --sentence-max-chars=${sentenceMaxChars} --chunk-max-chars=${chunkMaxChars}${previewArg}`;
}

function renderLayoutCommandPanel(configMap, videoType) {
    const cmd = state.layoutCommand || {};
    const mode = cmd.mode === 'batch' ? 'batch' : 'single';
    const engine = String(cmd.engine || 'sensevoice').trim() || 'sensevoice';
    const previewSeconds = Math.max(0, Number(cmd.previewSeconds || 0));
    const videoFile = String(cmd.videoFile || '').trim();
    const targetDir = String(cmd.targetDir || 'testvideos/测试视频-01-读书学语言').trim();
    const commandText = buildLayoutCommands(configMap, videoType);
    return `
        <div style="margin-top:14px; border:1px solid var(--border); border-radius:12px; padding:12px; background:var(--bg-card);">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                <div style="font-size:13px; font-weight:700; color:var(--text-primary);">一键命令生成</div>
                <button type="button" class="tool-btn-small" onclick="copyLayoutCommand()">复制命令</button>
            </div>
            <div style="margin-top:10px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px;">
                <label style="display:grid; gap:4px;">
                    <span style="font-size:11px; color:var(--text-secondary);">模式</span>
                    <select class="input-modern" onchange="layoutCmdUpdate('mode', this.value)">
                        <option value="single" ${mode === 'single' ? 'selected' : ''}>单视频调试</option>
                        <option value="batch" ${mode === 'batch' ? 'selected' : ''}>批处理脚本</option>
                    </select>
                </label>
                <label style="display:grid; gap:4px;">
                    <span style="font-size:11px; color:var(--text-secondary);">引擎</span>
                    <select class="input-modern" onchange="layoutCmdUpdate('engine', this.value)">
                        <option value="sensevoice" ${engine === 'sensevoice' ? 'selected' : ''}>sensevoice</option>
                        <option value="funasr" ${engine === 'funasr' ? 'selected' : ''}>funasr</option>
                        <option value="mlx_hq" ${engine === 'mlx_hq' ? 'selected' : ''}>mlx_hq</option>
                    </select>
                </label>
                <label style="display:grid; gap:4px;">
                    <span style="font-size:11px; color:var(--text-secondary);">预览秒数</span>
                    <input class="input-modern" type="number" min="0" max="120" step="1" value="${previewSeconds}" oninput="layoutCmdUpdate('previewSeconds', this.value)" />
                </label>
                <label style="display:grid; gap:4px;">
                    <span style="font-size:11px; color:var(--text-secondary);">${mode === 'single' ? '视频路径' : '目录路径'}</span>
                    <input class="input-modern" value="${escapeHtml(mode === 'single' ? videoFile : targetDir)}" placeholder="${mode === 'single' ? '/absolute/path/to/video.mp4' : 'testvideos/测试视频-01-读书学语言'}" oninput="layoutCmdUpdate('${mode === 'single' ? 'videoFile' : 'targetDir'}', this.value)" />
                </label>
            </div>
            <textarea readonly class="code-block" style="margin-top:10px; min-height:90px; font-size:12px;">${escapeHtml(commandText)}</textarea>
        </div>
    `;
}

function renderPromptField(conf) {
    const schema = VIDEO_CONFIG_SCHEMA[conf.key] || ASR_CONFIG_SCHEMA[conf.key];
    const value = String(conf.value || '');
    if (!schema) {
        return `
            <textarea class="text-area-modern" rows="6" onchange="saveConfig('${conf.key}', this.value)">${escapeHtml(value)}</textarea>
            <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
        `;
    }
    if (schema.type === 'boolean') {
        const checked = ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) ? 'checked' : '';
        return `
            <label style="display:flex; align-items:center; gap:10px; font-size:13px; color:var(--text-primary);">
                <input type="checkbox" ${checked} onchange="saveConfig('${conf.key}', this.checked ? '1' : '0')" />
                <span>${schema.label}</span>
            </label>
            <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
        `;
    }
    if (schema.type === 'color') {
        const colorVal = normalizeConfigValue(conf.key, value);
        return `
            <div style="display:flex; align-items:center; gap:12px;">
                <input type="color" value="${escapeHtml(colorVal)}" onchange="saveConfig('${conf.key}', this.value)" />
                <input class="input-modern" value="${escapeHtml(colorVal)}" onblur="saveConfig('${conf.key}', this.value)" />
            </div>
            <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
        `;
    }
    if (schema.type === 'number') {
        return `
            <input
                class="input-modern"
                type="number"
                min="${schema.min}"
                max="${schema.max}"
                step="${schema.step}"
                value="${escapeHtml(value)}"
                onblur="saveConfig('${conf.key}', this.value)"
            />
            <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
        `;
    }
    if (schema.type === 'select') {
        const options = Array.isArray(schema.options) ? schema.options : [];
        const selected = normalizeConfigValue(conf.key, value);
        return `
            <select class="input-modern" onchange="saveConfig('${conf.key}', this.value)">
                ${options.map((opt) => `<option value="${escapeHtml(opt.value)}" ${opt.value === selected ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')}
            </select>
            <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
        `;
    }
    return `
        <textarea class="text-area-modern" rows="${schema.rows || 6}" onchange="saveConfig('${conf.key}', this.value)">${escapeHtml(value)}</textarea>
        <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary);">${schema.hint || ''}</div>
        <div style="margin-top:8px; font-size:11px; color:var(--text-tertiary); text-align:right;">${conf.key}</div>
    `;
}

function renderPrompts() {
    const form = qs('configForm');
    if (!form) return;
    if (!state.configs.length) {
        form.innerHTML = '<div class="empty-state">暂无配置项</div>';
        return;
    }
    const videoConfigs = state.configs.filter((x) => x.key.startsWith('video_caption_'));
    const layoutConfigs = state.configs.filter((x) => x.key.startsWith('video_layout_'));
    const asrConfigs = state.configs.filter((x) => x.key in ASR_CONFIG_SCHEMA);
    const promptConfigs = state.configs.filter((x) => !x.key.startsWith('video_caption_') && !x.key.startsWith('video_layout_') && !(x.key in ASR_CONFIG_SCHEMA));
    const sections = [
        { title: '视频字幕效果配置', items: videoConfigs },
        { title: '布局模板配置', items: layoutConfigs },
        { title: '转写词库', items: asrConfigs },
        { title: '文案提示词配置', items: promptConfigs }
    ].filter((section) => section.items.length);
    form.innerHTML = sections.map((section) => `
        <div style="margin-bottom:20px;">
            <div style="font-size:15px; font-weight:700; margin-bottom:12px;">${section.title}</div>
            ${section.items.map(conf => `
        <div class="config-item" style="background:var(--bg-card); padding:20px; border-radius:12px; border:1px solid var(--border); margin-bottom:16px;">
            <div style="margin-bottom:12px; font-weight:600; font-size:14px;">${(VIDEO_CONFIG_SCHEMA[conf.key] || ASR_CONFIG_SCHEMA[conf.key])?.label || formatConfigKey(conf.key)}</div>
            ${renderPromptField(conf)}
        </div>
            `).join('')}
        </div>
    `).join('');
    renderLayoutTemplatePreview();
}

function getConfigMap() {
    return state.configs.reduce((acc, item) => {
        acc[item.key] = String(item.value ?? '');
        return acc;
    }, {});
}

function readNumericConfig(configMap, key, fallback) {
    const val = Number(configMap[key] ?? fallback);
    return Number.isFinite(val) ? val : fallback;
}

function clampBySchema(key, rawValue) {
    const schema = VIDEO_CONFIG_SCHEMA[key];
    const n = Number(rawValue);
    if (!schema || schema.type !== 'number' || !Number.isFinite(n)) return Number(rawValue) || 0;
    return Math.min(schema.max, Math.max(schema.min, n));
}

function updatePreviewTagValue(key, value) {
    const tag = qs(`preview_val_${key}`);
    if (tag) tag.textContent = normalizeConfigValue(key, value);
}

function syncConfigDraft(key, value) {
    const normalized = normalizeConfigValue(key, value);
    const idx = state.configs.findIndex((x) => x.key === key);
    if (idx >= 0) {
        state.configs[idx].value = normalized;
    } else {
        state.configs.push({ key, value: normalized });
    }
    updatePreviewTagValue(key, normalized);
}

function beginLayoutPreviewPointerTracking() {
    if (state.layoutPreviewPointerBound) return;
    state.layoutPreviewPointerBound = true;
    window.addEventListener('pointermove', (event) => {
        const drag = state.layoutPreviewDrag;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        const deltaXOnTarget = dx * drag.scaleX;
        const deltaYOnTarget = dy * drag.scaleY;
        if (drag.role === 'title') {
            const nextOffset = clampBySchema('video_layout_title_offset_y', drag.baseTitleOffsetY + deltaYOnTarget);
            syncConfigDraft('video_layout_title_offset_y', nextOffset);
            renderLayoutTemplatePreview();
            return;
        }
        const nextMarginV = clampBySchema('video_caption_subtitle_margin_v', drag.baseMarginV - deltaYOnTarget);
        syncConfigDraft('video_caption_subtitle_margin_v', nextMarginV);
        if (drag.baseAlign === 'left') {
            const nextMarginH = clampBySchema('video_caption_subtitle_margin_h', drag.baseMarginH + deltaXOnTarget);
            syncConfigDraft('video_caption_subtitle_margin_h', nextMarginH);
            syncConfigDraft('video_caption_subtitle_align', 'left');
        } else if (drag.baseAlign === 'right') {
            const nextMarginH = clampBySchema('video_caption_subtitle_margin_h', drag.baseMarginH - deltaXOnTarget);
            syncConfigDraft('video_caption_subtitle_margin_h', nextMarginH);
            syncConfigDraft('video_caption_subtitle_align', 'right');
        } else if (Math.abs(dx) <= 18) {
            syncConfigDraft('video_caption_subtitle_align', 'center');
        } else {
            const nextAlign = dx < 0 ? 'left' : 'right';
            const nextMarginH = clampBySchema('video_caption_subtitle_margin_h', 12 + Math.abs(deltaXOnTarget));
            syncConfigDraft('video_caption_subtitle_margin_h', nextMarginH);
            syncConfigDraft('video_caption_subtitle_align', nextAlign);
        }
        renderLayoutTemplatePreview();
    });
    window.addEventListener('pointerup', async () => {
        const drag = state.layoutPreviewDrag;
        if (!drag) return;
        state.layoutPreviewDrag = null;
        if (drag.role === 'title') {
            await window.previewConfigCommit('video_layout_title_offset_y', state.configs.find((x) => x.key === 'video_layout_title_offset_y')?.value || '0');
            return;
        }
        await window.previewConfigCommit('video_caption_subtitle_margin_v', state.configs.find((x) => x.key === 'video_caption_subtitle_margin_v')?.value || '42');
        await window.previewConfigCommit('video_caption_subtitle_margin_h', state.configs.find((x) => x.key === 'video_caption_subtitle_margin_h')?.value || '36');
        await window.previewConfigCommit('video_caption_subtitle_align', state.configs.find((x) => x.key === 'video_caption_subtitle_align')?.value || 'center');
    });
}

function renderLayoutTemplatePreview() {
    const panel = qs('layoutTemplatePreview');
    if (!panel) return;
    const configMap = getConfigMap();
    const videoType = qs('layoutPreviewType')?.value || 'landscape';
    const sourceSizeMap = {
        landscape: { w: 1920, h: 1080 },
        vertical: { w: 1080, h: 1920 },
        square: { w: 1080, h: 1080 },
        video_note: { w: 1080, h: 1920 }
    };
    const sourceSize = sourceSizeMap[videoType] || sourceSizeMap.landscape;
    const sourceW = sourceSize.w;
    const sourceH = sourceSize.h;
    const inputAspect = sourceW / sourceH;
    const isLikelySquare = inputAspect > 0.88 && inputAspect < 1.12;
    const isVertical = inputAspect > 0 && inputAspect < 0.72;
    const verticalAsNote = ['1', 'true', 'yes', 'on'].includes(String(configMap.video_layout_treat_vertical_as_video_note || '0').toLowerCase());
    const squareAsNote = ['1', 'true', 'yes', 'on'].includes(String(configMap.video_layout_treat_square_as_video_note || '1').toLowerCase());
    const isVideoNote = videoType === 'video_note' || (isVertical && verticalAsNote) || (isLikelySquare && squareAsNote);
    const confTargetW = Math.max(540, readNumericConfig(configMap, 'video_layout_target_w', 1080));
    const confTargetH = Math.max(960, readNumericConfig(configMap, 'video_layout_target_h', 1920));
    const targetW = isVideoNote ? confTargetW : sourceW;
    const targetH = isVideoNote ? confTargetH : sourceH;
    const shortEdge = Math.max(540, Math.min(targetW, targetH));
    const resScale = Math.max(1, shortEdge / 1080);
    const topRatio = Math.min(0.45, Math.max(0.05, readNumericConfig(configMap, 'video_layout_top_band_ratio', 0.2)));
    const bottomRatio = Math.min(0.45, Math.max(0.05, readNumericConfig(configMap, 'video_layout_bottom_band_ratio', 0.22)));
    const confHeadline = Math.max(16, readNumericConfig(configMap, 'video_layout_headline_font_size', 96));
    const confSubline = Math.max(14, readNumericConfig(configMap, 'video_layout_subline_font_size', 54));
    const confSubtitle = Math.max(11, readNumericConfig(configMap, 'video_layout_subtitle_font_size', 16));
    const subtitleAlign = normalizeConfigValue('video_caption_subtitle_align', configMap.video_caption_subtitle_align || 'center');
    const configuredSubtitleMarginH = Math.max(12, readNumericConfig(configMap, 'video_caption_subtitle_margin_h', 36));
    const configuredSubtitleMarginV = Math.max(16, readNumericConfig(configMap, 'video_caption_subtitle_margin_v', 42));
    const titleOffsetY = readNumericConfig(configMap, 'video_layout_title_offset_y', 0);
    const subtitleOffsetY = readNumericConfig(configMap, 'video_layout_subtitle_offset_y', 0);
    const subtitleColor = normalizeConfigValue('video_caption_subtitle_color', configMap.video_caption_subtitle_color || '#F2F4F8');
    const titleColor = normalizeConfigValue('video_caption_title_color', configMap.video_caption_title_color || configMap.video_caption_highlight_color || '#FFCF40');
    const topBandH = isVideoNote ? Math.max(360, Math.floor(targetH * topRatio)) : Math.max(180, Math.floor(targetH * 0.14));
    const bottomBandH = isVideoNote ? Math.floor(clampNumber(targetH * bottomRatio, 420, 600)) : 0;
    const defaultHeadlineFontSize = isVideoNote ? confHeadline : Math.floor(confHeadline * resScale);
    const defaultSublineFontSize = isVideoNote ? confSubline : Math.floor(confSubline * resScale);
    const titleSafeMargin = Math.max(40, Math.floor(targetW * 0.06));
    const titleMaxWidth = Math.max(280, targetW - titleSafeMargin * 2);
    const headlineCap = (isVertical ? 72 : 84) * (isVideoNote ? 1 : resScale);
    const sublineCap = (isVertical ? 46 : 56) * (isVideoNote ? 1 : resScale);
    const headlineBaseSize = Math.floor(clampNumber(defaultHeadlineFontSize, 16, headlineCap));
    const sublineBaseSize = Math.floor(clampNumber(defaultSublineFontSize, 14, sublineCap));
    const headlineFontSize = fitTextFontSizeByWidth('主标题示意', headlineBaseSize, titleMaxWidth, 16);
    const sublineFontSize = fitTextFontSizeByWidth('副标题提示意', sublineBaseSize, titleMaxWidth, 14);
    const defaultSubtitleFontSize = isVideoNote ? confSubtitle : Math.floor(confSubtitle * resScale * (isVertical ? 0.68 : 0.62));
    const maxSubtitleByFrame = Math.floor(targetH * (isVideoNote ? 0.04 : 0.032));
    const maxSubtitleByScale = Math.max(11, Math.floor(40 * (isVideoNote ? 1 : resScale)));
    const safeSubtitleFontSize = Math.floor(clampNumber(defaultSubtitleFontSize, 11, Math.min(maxSubtitleByScale, Math.max(11, maxSubtitleByFrame))));
    const subtitleMarginVBase = isVideoNote ? Math.floor(bottomBandH * 0.1) : Math.floor((isVertical ? 28 : 40) * resScale);
    const subtitleMarginVRaw = (Number.isFinite(configuredSubtitleMarginV) ? configuredSubtitleMarginV : subtitleMarginVBase) - subtitleOffsetY;
    const subtitleMarginV = isVideoNote
        ? Math.floor(clampNumber(subtitleMarginVRaw, 22, Math.max(36, bottomBandH - 24)))
        : Math.floor(clampNumber(subtitleMarginVRaw, Math.floor(20 * resScale), Math.floor(96 * resScale)));
    const subtitleMarginH = Math.floor(clampNumber(configuredSubtitleMarginH, 12, Math.floor(220 * resScale)));
    const titleLineGap = Math.floor(clampNumber(8 * resScale, 6, 40));
    let headlineY = 0;
    let sublineY = 0;
    if (isVideoNote) {
        const titleTopPadding = Math.floor(clampNumber(topBandH * 0.28, 40, 200));
        const headlineYRaw = titleTopPadding + titleOffsetY;
        headlineY = Math.floor(clampNumber(headlineYRaw, 12, Math.max(12, topBandH - headlineFontSize - 24)));
        const minSublineY = headlineY + headlineFontSize + titleLineGap;
        const maxSublineY = Math.max(minSublineY, topBandH - sublineFontSize - 16);
        sublineY = Math.floor(clampNumber(headlineY + headlineFontSize + titleLineGap, minSublineY, maxSublineY));
    } else {
        headlineY = Math.floor(clampNumber(Math.floor(targetH * 0.025) + titleOffsetY, 12, Math.floor(targetH * 0.15)));
        sublineY = headlineY + headlineFontSize + titleLineGap;
    }
    const stageMaxW = 420;
    const stageMaxH = 620;
    const previewScale = Math.min(stageMaxW / targetW, stageMaxH / targetH);
    const previewW = Math.max(220, Math.floor(targetW * previewScale));
    const previewH = Math.max(220, Math.floor(targetH * previewScale));
    const scaleByWidth = previewW / targetW;
    const scaleByHeight = previewH / targetH;
    const topBandPx = Math.floor(topBandH * scaleByHeight);
    const bottomBandPx = Math.floor(bottomBandH * scaleByHeight);
    const headlinePx = Math.max(14, Math.floor(headlineFontSize * scaleByWidth));
    const sublinePx = Math.max(12, Math.floor(sublineFontSize * scaleByWidth));
    const subtitlePx = Math.max(11, Math.floor(safeSubtitleFontSize * scaleByWidth));
    const headlineYPx = Math.floor(headlineY * scaleByHeight);
    const sublineYPx = Math.floor(sublineY * scaleByHeight);
    const subtitleY = Math.max(6, Math.floor(subtitleMarginV * scaleByHeight));
    const subtitleMarginHpx = Math.max(8, Math.floor(subtitleMarginH * scaleByWidth));
    const subtitleAlignCss = subtitleAlign === 'left' ? 'left' : (subtitleAlign === 'right' ? 'right' : 'center');
    const subtitleLeftCss = subtitleAlign === 'left' ? `${subtitleMarginHpx}px` : (subtitleAlign === 'right' ? 'auto' : '50%');
    const subtitleRightCss = subtitleAlign === 'right' ? `${subtitleMarginHpx}px` : 'auto';
    const subtitleTransform = subtitleAlign === 'center' ? 'translateX(-50%)' : 'none';
    const mode = videoType === 'video_note'
        ? 'Video Note 模板'
        : (videoType === 'vertical'
            ? (verticalAsNote ? '竖屏按 Video Note 模板' : '竖屏按原比例模板')
            : (videoType === 'square'
                ? (squareAsNote ? '方形按 Video Note 模板' : '方形按原比例模板')
                : '横屏按原比例模板'));
    panel.innerHTML = `
        <div class="layout-preview-head">
            <div class="layout-preview-title">模板预览</div>
            <div class="layout-preview-tag">${mode}</div>
        </div>
        <div class="layout-preview-stage" style="width:${previewW}px;height:${previewH}px;">
            ${isVideoNote ? `<div class="layout-band top" style="height:${topBandPx}px;"></div>` : ''}
            ${isVideoNote ? `<div class="layout-band bottom" style="height:${bottomBandPx}px;"></div>` : ''}
            <div class="layout-video-core"></div>
            <div class="layout-title-main layout-draggable" data-drag-role="title" style="font-size:${headlinePx}px;color:${titleColor};top:${headlineYPx}px;">主标题示意</div>
            <div class="layout-title-sub" style="font-size:${sublinePx}px;color:${titleColor};top:${sublineYPx}px;">副标题提示意</div>
            <div class="layout-subtitle layout-draggable" data-drag-role="subtitle" style="font-size:${subtitlePx}px;bottom:${subtitleY}px;color:${subtitleColor};left:${subtitleLeftCss};right:${subtitleRightCss};transform:${subtitleTransform};text-align:${subtitleAlignCss};background:transparent;padding:0;border-radius:0;">字幕示意，不遮挡主体画面</div>
        </div>
        <div style="margin-top:10px; font-size:12px; color:var(--text-secondary);">拖动主标题可调上下位置，拖动字幕可调底边和左右贴边。</div>
        <div style="margin-top:12px; display:grid; gap:10px;">
            ${renderPreviewControl('video_layout_title_offset_y', '标题上下偏移', -220, 220, 1)}
            ${renderPreviewControl('video_layout_subtitle_offset_y', '字幕上下偏移', -220, 220, 1)}
            ${renderPreviewControl('video_caption_subtitle_margin_v', '字幕底部边距', 16, 180, 1)}
            ${renderPreviewControl('video_caption_subtitle_margin_h', '字幕左右边距', 12, 180, 1)}
        </div>
        ${renderLayoutCommandPanel(configMap, videoType)}
    `;
    beginLayoutPreviewPointerTracking();
    const stage = panel.querySelector('.layout-preview-stage');
    if (!stage) return;
    panel.querySelectorAll('.layout-draggable').forEach((node) => {
        node.addEventListener('pointerdown', (event) => {
            const role = node.getAttribute('data-drag-role') || '';
            if (!role) return;
            event.preventDefault();
            const config = getConfigMap();
            const currentAlign = normalizeConfigValue('video_caption_subtitle_align', config.video_caption_subtitle_align || 'center');
            const stageRect = stage.getBoundingClientRect();
            state.layoutPreviewDrag = {
                role,
                startX: event.clientX,
                startY: event.clientY,
                baseAlign: currentAlign,
                baseTitleOffsetY: readNumericConfig(config, 'video_layout_title_offset_y', 0),
                baseMarginV: readNumericConfig(config, 'video_caption_subtitle_margin_v', 42),
                baseMarginH: readNumericConfig(config, 'video_caption_subtitle_margin_h', 36),
                scaleX: targetW / Math.max(1, stageRect.width),
                scaleY: targetH / Math.max(1, stageRect.height)
            };
        });
    });
}

function renderPreviewControl(key, label, min, max, step) {
    const conf = state.configs.find((x) => x.key === key);
    const raw = conf ? String(conf.value ?? '') : '';
    const normalized = normalizeConfigValue(key, raw || String(VIDEO_CONFIG_SCHEMA[key]?.fallback ?? 0));
    return `
        <label style="display:grid; grid-template-columns: 120px 1fr 52px; gap:8px; align-items:center;">
            <span style="font-size:12px; color:var(--text-secondary);">${label}</span>
            <input type="range" min="${min}" max="${max}" step="${step}" value="${normalized}" oninput="previewConfigInput('${key}', this.value)" onchange="previewConfigCommit('${key}', this.value)" />
            <span id="preview_val_${key}" style="font-family:var(--font-mono); font-size:12px; color:var(--text-primary); text-align:right;">${normalized}</span>
        </label>
    `;
}

function formatConfigKey(key) {
    // Simple formatter
    return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

window.exportConfigs = () => {
    window.location.href = '/admin/api/configs/export';
};

window.resetPending = async (id) => {
    if (!confirm('将此 Pending 任务重置为 Ready 状态？')) return;
    try {
        const item = await api(`/admin/api/contents/${id}/reset-pending`, { method: 'POST' });
        toast('已重置为 Ready', 'success');
        await loadContents();
        selectContent(item.id);
    } catch (e) {
        toast('重置失败: ' + e.message, 'error');
    }
};

window.saveConfig = async (key, value) => {
    try {
        const normalized = normalizeConfigValue(key, value);
        await api(`/admin/api/configs/${key}`, {
            method: 'PUT',
            body: JSON.stringify({ value: normalized })
        });
        const idx = state.configs.findIndex((x) => x.key === key);
        if (idx >= 0) state.configs[idx].value = normalized;
        renderLayoutTemplatePreview();
        toast('Config saved', 'success');
    } catch (e) {
        toast('保存失败: ' + e.message, 'error');
    }
};

window.previewConfigInput = (key, value) => {
    syncConfigDraft(key, value);
    renderLayoutTemplatePreview();
};

window.previewConfigCommit = async (key, value) => {
    await window.saveConfig(key, value);
    const normalized = normalizeConfigValue(key, value);
    const tag = qs(`preview_val_${key}`);
    if (tag) tag.textContent = normalized;
};

window.layoutCmdUpdate = (key, value) => {
    if (!state.layoutCommand) state.layoutCommand = {};
    state.layoutCommand[key] = key === 'previewSeconds'
        ? Math.max(0, Number(value || 0))
        : String(value ?? '');
    renderLayoutTemplatePreview();
};

window.copyLayoutCommand = async () => {
    const configMap = getConfigMap();
    const videoType = qs('layoutPreviewType')?.value || 'landscape';
    const commandText = buildLayoutCommands(configMap, videoType);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(commandText);
            toast('命令已复制', 'success');
            return;
        }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = commandText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('命令已复制', 'success');
};

// --- File Manager ---

async function loadFiles() {
    const group = qs('fileGroupSelect').value;
    try {
        const res = await api(`/admin/api/files?group=${group}`);
        // Server returns object with keys matching groups
        // e.g. { audio_inputs: [], debug_video: [] ... }
        // We need to pick the right one based on group, OR update all if server sends all
        
        if (res[group]) {
            state.files[group] = res[group];
        } else {
             // Fallback if server structure changes or returns just the array (unlikely based on server.js code)
             // But server.js returns ALL groups every time.
             Object.keys(res).forEach(k => {
                 if (state.files[k] !== undefined) {
                     state.files[k] = res[k];
                 }
             });
        }
        
        renderFileList(group);
    } catch (e) { console.error(e); }
}

function renderFileList(group) {
    const list = qs('fileList');
    const files = state.files[group] || [];
    
    list.innerHTML = files.map((f) => `
        <div class="list-item" onclick="previewFile('${f.abs_path}', '${group}')">
            <div class="item-title">${f.name}</div>
            <div style="font-size:11px; color:var(--text-tertiary); margin-top:4px;">${f.rel_path}</div>
        </div>
    `).join('');
}


// --- Helper for Time Parsing ---
function parseTimeStr(str) {
    if (!str) return 0;
    // 00:00:01,000 or 00:01.000 or 123.45
    const parts = str.replace(',', '.').split(':');
    let seconds = 0;
    if (parts.length === 3) {
        seconds += parseInt(parts[0]) * 3600;
        seconds += parseInt(parts[1]) * 60;
        seconds += parseFloat(parts[2]);
    } else if (parts.length === 2) {
        seconds += parseInt(parts[0]) * 60;
        seconds += parseFloat(parts[1]);
    } else {
        seconds = parseFloat(str);
    }
    return seconds;
}

function parseTimelineLine(line) {
    // Try simple float format: "1.23 --> 4.56 Text"
    let match = line.match(/^([\d\.]+)\s-->\s([\d\.]+)\s(.*)$/);
    if (match) {
        return { start: parseFloat(match[1]), end: parseFloat(match[2]), text: match[3] };
    }
    
    // Try SRT format: "00:00:00,000 --> 00:00:02,000 Text"
    // We match roughly "digits:digits..." --> "digits:digits..."
    // Simpler regex: anything --> anything text
    match = line.match(/^(.+?)\s-->\s(.+?)\s(.*)$/);
    if (match) {
        const t1 = parseTimeStr(match[1]);
        const t2 = parseTimeStr(match[2]);
        if (!isNaN(t1) && !isNaN(t2)) {
             return { start: t1, end: t2, text: match[3] };
        }
    }
    return { text: line };
}

window.seekAudio = (time) => {
    const player = document.getElementById('media-player');
    if (player) {
        player.currentTime = time;
        player.play();
    }
};

window.previewFile = async (absPath, group) => {
    const container = qs('filePreviewContainer');
    container.innerHTML = '<div style="color:var(--text-tertiary)">Loading...</div>';
    
    // If video/audio
    if (/\.(mp4|mov|webm|mp3|m4a|wav|ogg|oga|flac)$/i.test(absPath)) {
        const tag = /\.(mp4|mov|webm)$/i.test(absPath) ? 'video' : 'audio';
        
        let mediaSrc = streamUrl(absPath);
        
        // For audio, use the playback endpoint to ensure compatibility and get metadata if needed
        if (tag === 'audio') {
            try {
                const playbackRes = await api(`/admin/api/file-playback?path=${encodeURIComponent(absPath)}`);
                if (playbackRes.stream_url) {
                    mediaSrc = playbackRes.stream_url;
                }
            } catch (e) {
                console.warn('Playback prep failed, falling back to raw stream', e);
            }
        }

        container.innerHTML = `
            <div style="background:var(--bg-app); padding:20px; border-radius:12px; display:flex; flex-direction:column; align-items:center; gap:12px; width: 100%;">
                <${tag} id="media-player" controls preload="metadata" src="${mediaSrc}" style="width:100%; max-height:400px; outline:none; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1);"></${tag}>
                
                <div style="width:100%; display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--text-secondary); padding: 0 4px;">
                    <span style="font-weight:500; color:var(--text-primary);">${absPath.split('/').pop()}</span>
                    <div style="display:flex; gap:12px; align-items:center;">
                        <span id="media-duration" style="font-feature-settings: 'tnum';">--:--</span>
                        <a href="${streamUrl(absPath)}" download class="tool-btn-small" style="text-decoration:none; display:flex; align-items:center; gap:4px;">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            下载
                        </a>
                    </div>
                </div>

                <div id="audio-timeline-preview" style="width:100%; display:none;">
                    <div class="timeline-container">
                        <div class="timeline-header">
                            <div class="timeline-title">时间轴字幕</div>
                            <div class="status-badge processing" style="font-size:10px;">Preview</div>
                        </div>
                        <div id="timeline-content" class="timeline-scroll-area">
                            <div style="padding:20px; text-align:center; color:var(--text-tertiary);">Loading timeline...</div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Handle duration display
        const player = document.getElementById('media-player');
        if (player) {
            player.addEventListener('loadedmetadata', () => {
                const d = player.duration;
                if (d && !isNaN(d)) {
                    const m = Math.floor(d / 60);
                    const s = Math.floor(d % 60);
                    document.getElementById('media-duration').textContent = `${m}:${s.toString().padStart(2, '0')}`;
                }
            });
            
            // Highlight active segment
            player.addEventListener('timeupdate', () => {
                const t = player.currentTime;
                const segments = document.querySelectorAll('.timeline-segment');
                segments.forEach(seg => {
                    const start = parseFloat(seg.dataset.start);
                    const end = parseFloat(seg.dataset.end);
                    if (t >= start && t < end) {
                        if (!seg.classList.contains('active')) {
                            seg.classList.add('active');
                            seg.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); 
                        }
                    } else {
                        seg.classList.remove('active');
                    }
                });
            });
        }

        // Fetch timeline if it's audio or video
        if (tag === 'audio' || tag === 'video') {
            try {
                // Ensure elements exist before trying to access them
                // They are part of the innerHTML set above, so they should be there.
                // However, we wait a tick to be safe or just access them directly.
                const timelineDiv = document.getElementById('audio-timeline-preview');
                const contentDiv = document.getElementById('timeline-content');

                if (!timelineDiv || !contentDiv) return;

                const timelineData = await api(`/admin/api/audio-timeline?path=${encodeURIComponent(absPath)}`);
                
                if (timelineData && timelineData.lines && timelineData.lines.length > 0) {
                    timelineDiv.style.display = 'block';
                    
                    // Parse lines if they are strings (from SRT) or use objects if from JSON
                    const parsedLines = timelineData.lines.map(line => {
                        if (typeof line === 'string') return parseTimelineLine(line);
                        return line; // Assume already object {start, end, text}
                    });

                    contentDiv.innerHTML = parsedLines.map((seg, index) => {
                        if (seg && seg.start !== undefined) {
                            return `
                            <div class="timeline-segment" data-start="${seg.start}" data-end="${seg.end}" onclick="seekAudio(${seg.start})">
                                <div class="ts-time">${formatTime(seg.start)}</div>
                                <div class="ts-text">${seg.text}</div>
                            </div>`;
                        }
                        return `<div style="padding:4px 12px; color:var(--text-secondary); font-size:12px;">${seg.text || seg}</div>`;
                    }).join('');
                    
                    // Update status badge if available
                    if (timelineData.status) {
                        const badge = timelineDiv.querySelector('.status-badge');
                        if (badge) badge.outerHTML = statusBadge(timelineData.status === '已生成' ? 'reviewing' : 'processing'); 
                    }

                } else {
                    timelineDiv.style.display = 'block';
                    contentDiv.innerHTML = '<div style="color:var(--text-tertiary); text-align:center; padding:20px;">暂无字幕数据</div>';
                }
            } catch (e) {
                console.warn('Failed to load timeline', e);
            }
        }
        return;
    }


    // If text/json
    try {
        const res = await fetch(`/admin/api/file-content?path=${encodeURIComponent(absPath)}`);
        const text = await res.text();
        
        // If it is a transcript JSON, try to format it nicely
        if (group === 'transcribe_json' || absPath.endsWith('.json')) {
             try {
                 const json = JSON.parse(text);
                 // If it has segments, render timeline
                 if (json.segments) {
                     renderTimeline(json.segments, container);
                     return;
                 }
                 container.textContent = JSON.stringify(json, null, 2);
             } catch (e) {
                 container.textContent = text;
             }
        } else {
            container.textContent = text;
        }
    } catch (e) {
        container.textContent = '无法读取文件内容';
    }
};

function renderTimeline(segments, container) {
    const html = segments.map(seg => `
        <div style="display:flex; gap:12px; padding:8px 0; border-bottom:1px solid var(--border);">
            <div style="font-family:var(--font-mono); color:var(--accent); font-size:11px; width:80px; flex-shrink:0;">
                ${formatTime(seg.start)} -> ${formatTime(seg.end)}
            </div>
            <div style="color:var(--text-primary); font-size:13px;">${seg.text}</div>
        </div>
    `).join('');
    container.innerHTML = `<div style="display:flex; flex-direction:column;">${html}</div>`;
}

function formatTime(sec) {
    if (sec === undefined || sec === null || isNaN(sec)) return '00:00.00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
}

// --- Upload View ---

const uploadState = {
    file: null,
    taskId: null,
    pollTimer: null
};

function initUploadView() {
    const dropZone = qs('uploadDropZone');
    const fileInput = qs('uploadFileInput');
    const chooseBtn = qs('uploadChooseBtn');
    const submitBtn = qs('uploadSubmitBtn');
    if (!dropZone || !fileInput || !submitBtn) return;

    function setFile(file) {
        uploadState.file = file;
        const label = qs('uploadDropLabel');
        if (file) {
            dropZone.classList.add('has-file');
            if (label) label.innerHTML = `<span style="font-weight:600;color:var(--text-primary);">${file.name}</span><br><span style="font-size:12px;color:var(--text-tertiary);">${(file.size / 1024 / 1024).toFixed(1)} MB — 点击重新选择</span>`;
        } else {
            dropZone.classList.remove('has-file');
            if (label) label.innerHTML = '拖拽视频/音频到这里，或<span style="color:var(--blue);cursor:pointer;" id="uploadChooseBtn">点击选择文件</span><div style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">支持：MP4 MOV AVI MKV MP3 WAV M4A OGG</div>';
        }
    }

    dropZone.addEventListener('click', () => fileInput.click());
    if (chooseBtn) chooseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const f = e.dataTransfer.files[0];
        if (f) setFile(f);
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) setFile(fileInput.files[0]);
    });

    submitBtn.addEventListener('click', startUpload);
}

function startUpload() {
    if (!uploadState.file) { toast('请先选择文件', 'error'); return; }
    const file = uploadState.file;
    const headline = (qs('uploadHeadline') || {}).value || '';
    const subline = (qs('uploadSubline') || {}).value || '';
    const mode = (qs('uploadMode') || {}).value || 'default';

    const formData = new FormData();
    formData.append('file', file);
    if (headline.trim()) formData.append('headline', headline.trim());
    if (subline.trim()) formData.append('subline', subline.trim());
    formData.append('mode', mode);

    const submitBtn = qs('uploadSubmitBtn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '上传中...'; }

    const progressEl = qs('uploadProgress');
    if (progressEl) progressEl.style.display = 'none';

    fetch('/admin/api/upload', { method: 'POST', body: formData })
        .then((res) => res.json())
        .then((data) => {
            if (data.error) throw new Error(data.error);
            uploadState.taskId = data.taskId;
            if (progressEl) progressEl.style.display = 'block';
            const metaEl = qs('uploadTaskMeta');
            if (metaEl) metaEl.textContent = `任务 ${data.taskId} | 文件: ${file.name}`;
            toast('文件已上传，处理开始', 'success');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '开始处理'; }
            uploadState.file = null;
            const dropZone = qs('uploadDropZone');
            const dropLabel = qs('uploadDropLabel');
            if (dropZone) dropZone.classList.remove('has-file');
            if (dropLabel) dropLabel.innerHTML = '拖拽视频/音频到这里，或<span style="color:var(--blue);cursor:pointer;">点击选择文件</span><div style="font-size:12px;color:var(--text-tertiary);margin-top:6px;">支持：MP4 MOV AVI MKV MP3 WAV M4A OGG</div>';
            const fi = qs('uploadFileInput');
            if (fi) fi.value = '';
            startUploadPoll(data.taskId);
        })
        .catch((err) => {
            toast(err.message || '上传失败', 'error');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '开始处理'; }
        });
}

function startUploadPoll(taskId) {
    if (uploadState.pollTimer) clearInterval(uploadState.pollTimer);
    uploadState.pollTimer = setInterval(() => pollUploadTask(taskId), 2000);
}

async function pollUploadTask(taskId) {
    try {
        const res = await fetch(`/admin/api/tasks/${taskId}`);
        if (!res.ok) return;
        const task = await res.json();
        const pct = task.progressPct || 0;
        const bar = qs('uploadProgressBar');
        const label = qs('uploadProgressLabel');
        const pctEl = qs('uploadProgressPct');
        if (bar) bar.style.width = `${pct}%`;
        if (label) label.textContent = task.stepTitle || '处理中...';
        if (pctEl) pctEl.textContent = `${pct}%`;

        if (task.status === 'done' || task.status === 'failed') {
            if (uploadState.pollTimer) { clearInterval(uploadState.pollTimer); uploadState.pollTimer = null; }
            if (task.status === 'done') {
                toast('处理完成！正在跳转到内容列表...', 'success');
                setTimeout(() => {
                    loadContents();
                    switchView('content');
                }, 1200);
            } else {
                toast(`处理失败: ${task.error || '未知错误'}`, 'error');
                const label2 = qs('uploadProgressLabel');
                if (label2) label2.textContent = `失败: ${task.error || '未知错误'}`;
            }
        }
    } catch (_) {}
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
    // Nav
    document.querySelectorAll('.nav-item').forEach((btn) => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // Content Filter
    qs('statusTabs').addEventListener('click', (e) => {
        if (e.target.classList.contains('segment-btn')) {
            document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            state.statusFilter = e.target.dataset.status;
            renderList();
        }
    });

    // Search
    let searchTimer;
    const searchInput = qs('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                const items = document.querySelectorAll('#contentList .list-item');
                items.forEach(el => {
                    const text = el.textContent.toLowerCase();
                    el.style.display = text.includes(term) ? 'block' : 'none';
                });
            }, 300);
        });
    }
    
    const fileGroupSelect = qs('fileGroupSelect');
    if (fileGroupSelect) {
        fileGroupSelect.addEventListener('change', () => {
             loadFiles();
             // Clear preview
             qs('filePreviewContainer').innerHTML = '';
        });
    }
    
    const refreshFilesBtn = qs('refreshFilesBtn');
    if (refreshFilesBtn) {
        refreshFilesBtn.addEventListener('click', loadFiles);
    }
    initUploadView();
    qs('editorForm').addEventListener('submit', saveContent);
    qs('regenMomentsBtn').addEventListener('click', () => regenerate('moments'));
    qs('regenArticleBtn').addEventListener('click', () => regenerate('article'));
    qs('regenVideoBtn').addEventListener('click', () => regenerate('video'));
    qs('regenAllBtn').addEventListener('click', () => regenerate('all'));
    const layoutPreviewType = qs('layoutPreviewType');
    if (layoutPreviewType) {
        layoutPreviewType.addEventListener('change', renderLayoutTemplatePreview);
    }
    
    // Global Refresh
    qs('refreshBtn').addEventListener('click', () => {
        loadSummary();
        loadContents();
        toast('Refreshed', 'success');
    });

    // Initial Load
    loadSummary();
    loadContents();
    
    // Preload file lists
    api('/admin/api/files').then(r => {
        if (r.debug_video) state.files.debug_video = r.debug_video;
        if (r.generated_videos) state.files.generated_videos = r.generated_videos;
        if (r.audio_inputs) state.files.audio_inputs = r.audio_inputs;
        if (r.video_inputs) state.files.video_inputs = r.video_inputs;
        if (r.incoming_files) state.files.incoming_files = r.incoming_files;
        if (r.logs) state.files.logs = r.logs;
    });

    // Auto-refresh every 30s
    setInterval(() => {
        if (state.activeView === 'overview') {
            loadSummary();
            loadContents();
        }
    }, 30000);
});

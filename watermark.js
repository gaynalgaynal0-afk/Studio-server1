(function () {
  if (window.__jvWatermarkInjected) return;
  window.__jvWatermarkInjected = true;

  // ── Constants ──────────────────────────────────────────────────────────────
  const JV_USERNAME   = 'jv_60fps';
  const JV_MENTION    = '@jv_60fps';
  const JV_USER_ID    = '7468345666680587271';
  const JV_SIG_PREFIX = '• Upload Method → ';
  const COLLAB_SIG    = `${JV_SIG_PREFIX}${JV_MENTION}`;

  const CAPTION_KEYS = new Set([
    'caption','captiontext','captiontextdraft','captiondraft',
    'markuptext','text','title','desc','description',
    'itemdescription','itemdesc','video_description','videodescription',
    'posttext','posttitle','videodesc','video_title','videotitle',
  ]);

  const TECHNICAL_BRANCH_RE = /(?:music|audio|cover|url|uri|path|file|id|uid|sec|user|author|hash|token|key|material|effect|sticker|challenge)/i;
  const TECHNICAL_VALUE_RE  = /^(?:https?:\/\/|\/|blob:|data:|urn:|[a-z]:\\)/i;
  const COLLAB_SIG_RE       = /\s*•\s*Upload Method\s*→\s*@jv_60fps\s*/g;
  const COLLAB_MENTION_RE   = /(?:@jv_60fps\s*)+/g;

  // ── Text helpers ───────────────────────────────────────────────────────────
  function escapeText(t) {
    return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escapeAttr(t) {
    return escapeText(t).replace(/"/g,'&quot;');
  }
  function stripMarkupTags(t) {
    return String(t || '').replace(/<\/?[hm][^>]*>/g, '');
  }
  function stripSig(t) {
    return stripMarkupTags(t)
      .replace(/&amp;/g,'&')
      .split(COLLAB_SIG).join('')
      .replace(COLLAB_SIG_RE,'')
      .replace(COLLAB_MENTION_RE,'')
      .trimEnd();
  }
  function appendSig(t) {
    const clean = stripSig(t);
    return clean ? `${clean} ${COLLAB_SIG}` : COLLAB_SIG;
  }

  // ── text_extra helpers ─────────────────────────────────────────────────────
  function getExtraText(item, text) {
    const s = Number(item && item.start), e = Number(item && item.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
    return String(text || '').slice(s, e);
  }
  function isJvMention(item, text) {
    if (!item || Number(item.type) !== 0) return false;
    return String(item.hashtag_name||'').replace(/^@/,'') === JV_USERNAME
        || getExtraText(item, text) === JV_MENTION
        || String(item.user_id||item.userId||'') === JV_USER_ID;
  }
  function nextTagId(textExtra) {
    const used = new Set((Array.isArray(textExtra) ? textExtra : [])
      .filter(i => i && i.tag_id != null)
      .map(i => String(i.tag_id)));
    let id = 0;
    while (used.has(String(id))) id++;
    return String(id);
  }
  function appendTextExtra(textExtra, text) {
    const next = Array.isArray(textExtra)
      ? textExtra.filter(i => !isJvMention(i, text))
      : [];
    const start = String(text || '').lastIndexOf(JV_MENTION);
    if (start === -1) return next;
    next.push({ tag_id: nextTagId(next), start, end: start + JV_MENTION.length,
                user_id: JV_USER_ID, type: 0, hashtag_name: '' });
    return next;
  }
  function getMentionTagId(textExtra, finalText) {
    const start = String(finalText || '').lastIndexOf(JV_MENTION);
    const end   = start + JV_MENTION.length;
    const m = Array.isArray(textExtra)
      ? textExtra.find(i => i && Number(i.type) === 0
          && String(i.user_id||i.userId||'') === JV_USER_ID
          && Number(i.start) === start && Number(i.end) === end)
      : null;
    return m && m.tag_id != null ? String(m.tag_id) : '0';
  }
  function buildMarkup(baseMarkup, textExtra, finalText) {
    const clean = String(baseMarkup || '')
      .replace(/\s*•\s*Upload Method\s*→\s*(?:<m id="[^"]+">@jv_60fps<\/m>|@jv_60fps)\s*/g,'')
      .replace(COLLAB_SIG_RE,'').replace(COLLAB_MENTION_RE,'').trimEnd();
    const tagId = getMentionTagId(textExtra, finalText);
    const part  = `${escapeText(JV_SIG_PREFIX)}<m id="${escapeAttr(tagId)}">${escapeText(JV_MENTION)}</m>`;
    return clean ? `${clean} ${part}` : part;
  }

  // ── Payload detection ──────────────────────────────────────────────────────
  function isPublishPayload(p) {
    return !!(p && typeof p === 'object' && (
      Array.isArray(p.single_post_req_list) ||
      Array.isArray(p.post_items) ||
      Array.isArray(p.item_list) ||
      p.post_common_info || p.item_common_info ||
      p.publish_info     || p.item_info
    ));
  }
  function isTikTokPublishUrl(url) {
    return typeof url === 'string' && (
      url.includes('tiktok/web/project/post/v1/') ||
      (/(?:post|publish|upload|aweme|item)/i.test(url) && /tiktok/i.test(url))
    );
  }
  function getUrl(resource) {
    return typeof resource === 'string' ? resource
         : resource && typeof resource.url === 'string' ? resource.url : '';
  }

  // ── Caption field helpers ──────────────────────────────────────────────────
  function normKey(k) { return String(k||'').replace(/[_-]/g,'').toLowerCase(); }
  function isCaptionKey(k) { return CAPTION_KEYS.has(normKey(k)); }
  function skipBranch(k) {
    return TECHNICAL_BRANCH_RE.test(String(k||'')) && !/(?:caption|desc|title|text|post)/i.test(String(k||''));
  }
  function safeCaptionVal(v) {
    return typeof v === 'string' && v.length <= 2200 && !TECHNICAL_VALUE_RE.test(v.trim());
  }

  function ensureStringPath(root, path) {
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      node = node && node[path[i]];
      if (!node || typeof node !== 'object') return false;
    }
    const k = path[path.length - 1];
    if (!safeCaptionVal(node[k])) return false;
    const next = appendSig(node[k]);
    if (node[k] === next) return false;
    node[k] = next;
    return true;
  }

  // Main: apply signature to structured single_post_req_list
  function ensureStructured(payload) {
    if (!Array.isArray(payload.single_post_req_list)) return false;
    let changed = false;
    payload.single_post_req_list.forEach(req => {
      const info = req && req.single_post_feature_info;
      if (!info || typeof info !== 'object') return;
      const base       = stripSig(info.text || info.markup_text || '');
      const finalText  = appendSig(base);
      const finalExtra = appendTextExtra(info.text_extra, finalText);
      const finalMup   = buildMarkup(info.markup_text || escapeText(base), finalExtra, finalText);
      if (info.text !== finalText)                                        { info.text        = finalText;  changed = true; }
      if (info.markup_text !== finalMup)                                  { info.markup_text = finalMup;   changed = true; }
      if (JSON.stringify(info.text_extra||[]) !== JSON.stringify(finalExtra)) { info.text_extra = finalExtra; changed = true; }
    });
    return changed;
  }

  // Fallback: walk all caption keys in the payload
  function ensureWalked(payload) {
    if (Array.isArray(payload.single_post_req_list)) return false; // handled above
    const seen = new WeakSet();
    let changed = false;
    function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return;
      seen.add(node);
      Object.keys(node).forEach(k => {
        const v = node[k];
        if (normKey(k) === 'markuptext' && safeCaptionVal(v)) {
          const fp  = appendSig(stripSig(v));
          const fe  = appendTextExtra([], fp);
          const mup = buildMarkup(v, fe, fp);
          if (v !== mup) { node[k] = mup; changed = true; }
          return;
        }
        if (isCaptionKey(k) && safeCaptionVal(v)) {
          const next = appendSig(v);
          if (v !== next) { node[k] = next; changed = true; }
          return;
        }
        if (v && typeof v === 'object' && !skipBranch(k)) walk(v, depth + 1);
      });
    }
    walk(payload, 0);
    return changed;
  }

  // Fallback: known TikTok caption slot paths
  function ensureKnownSlots(payload) {
    let changed = false;
    if (Array.isArray(payload.single_post_req_list)) {
      payload.single_post_req_list.forEach(req => {
        if (!req || typeof req !== 'object') return;
        [['caption'],['desc'],['title'],['text'],['description'],
         ['single_post_feature_info','caption'],
         ['single_post_feature_info','desc'],
         ['single_post_feature_info','markup_text'],
         ['single_post_feature_info','title'],
         ['single_post_feature_info','text'],
         ['single_post_feature_info','description'],
        ].forEach(path => { if (ensureStringPath(req, path)) changed = true; });
      });
    }
    if (payload.post_common_info && typeof payload.post_common_info === 'object') {
      ['caption','desc','title','text','description'].forEach(k => {
        if (ensureStringPath(payload.post_common_info, [k])) changed = true;
      });
    }
    return changed;
  }

  // ── Entry point ────────────────────────────────────────────────────────────
  function injectSignature(payload) {
    if (!isPublishPayload(payload)) return;
    const structured = ensureStructured(payload);
    if (Array.isArray(payload.single_post_req_list)) return;
    if (!ensureWalked(payload)) ensureKnownSlots(payload);
  }

  function patchBodyText(text) {
    try {
      const obj = JSON.parse(text);
      injectSignature(obj);
      return JSON.stringify(obj);
    } catch (e) { return text; }
  }

  // ── Hook 1: JSON.stringify ─────────────────────────────────────────────────
  const _origStringify = JSON.stringify;
  JSON.stringify = function (value, replacer, space) {
    if (value && typeof value === 'object') {
      try { injectSignature(value); } catch (e) {}
    }
    return _origStringify.call(this, value, replacer, space);
  };
  JSON.stringify.toString = function () { return _origStringify.toString(); };

  // ── Hook 2: fetch ──────────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (resource, options = {}) {
    if (isTikTokPublishUrl(getUrl(resource))) {
      if (options.body && typeof options.body === 'string') {
        try { options.body = patchBodyText(options.body); } catch (e) {}
      } else if (typeof Request !== 'undefined' && resource instanceof Request) {
        try {
          const text = await resource.clone().text();
          if (text) resource = new Request(resource, { body: patchBodyText(text) });
        } catch (e) {}
      }
    }
    return _origFetch.call(this, resource, options);
  };
  window.fetch.toString = function () { return _origFetch.toString(); };

  // ── Hook 3: XHR ───────────────────────────────────────────────────────────
  const _origOpen = XMLHttpRequest.prototype.open;
  const _origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._jvUrl = url;
    return _origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (isTikTokPublishUrl(this._jvUrl) && typeof body === 'string') {
      try { body = patchBodyText(body); } catch (e) {}
    }
    return _origSend.call(this, body);
  };

})();

(function () {

  // ── Guard: only run on TikTok upload page ──────────────────────────────────
  function isUploadPage() {
    try {
      var loc = new URL(location.href);
      return loc.hostname === 'www.tiktok.com' && loc.pathname.indexOf('/upload') !== -1;
    } catch (e) { return false; }
  }

  if (!isUploadPage()) return;

  // ── Save originals before any hooks ───────────────────────────────────────
  var _origCreateURL = URL.createObjectURL.bind(URL);
  var _origStringify = JSON.stringify;
  var _origParse     = JSON.parse;
  var _origDefProp   = Object.defineProperty.bind(Object);
  var _origGetDesc   = Object.getOwnPropertyDescriptor.bind(Object);
  var _origValues    = Object.values.bind(Object);
  var _origXhrSend   = XMLHttpRequest.prototype.send;
  var _origFetch     = window.fetch;

  // ── Build 28-byte dummy MP4 blob (ftyp + empty mdat) ─────────────────────
  var _dummyUrl = null;
  try {
    var ftyp = new Uint8Array([
      0x00,0x00,0x00,0x14, 0x66,0x74,0x79,0x70,  // ftyp box (20 bytes)
      0x69,0x73,0x6F,0x6D, 0x00,0x00,0x00,0x00,  // major brand: isom
      0x69,0x73,0x6F,0x6D,                         // compatible: isom
      0x00,0x00,0x00,0x08, 0x6D,0x64,0x61,0x74   // mdat box (8 bytes, empty)
    ]);
    _dummyUrl = _origCreateURL(new Blob([ftyp], { type: 'video/mp4' }));
  } catch (e) {}

  // ── State ──────────────────────────────────────────────────────────────────
  var active = false;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function isUploadPayload(obj) {
    return !!(
      obj.single_post_req_list  ||
      obj.vedit_common_info     ||
      obj.post_common_info      ||
      obj.feature_common_info_list
    );
  }

  // Patch the snapshot JSON string (editor config) embedded inside the payload
  function patchSnapshot(raw) {
    try {
      var snap = _origParse(raw);
      if (snap.OutputInfo) {
        snap.OutputInfo.Fps = 60;
        if (snap.OutputInfo.Width  < 1080) snap.OutputInfo.Width  = 1080;
        if (snap.OutputInfo.Height < 1350) snap.OutputInfo.Height = 1350;
      }
      if (Array.isArray(snap.Elements)) {
        for (var i = 0; i < snap.Elements.length; i++) {
          if (snap.Elements[i].Fps != null) snap.Elements[i].Fps = 60;
        }
      }
      return _origStringify(snap);
    } catch (e) { return raw; }
  }

  // Recursively apply all 60fps / no-transcode patches to the payload object
  function applyParams(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return;
    try {
      if (obj.post_type === 2)                    obj.post_type  = 3;
      if (typeof obj.fps        === 'number')      obj.fps        = 60;
      if (typeof obj.frame_rate === 'number')      obj.frame_rate = 60;
      if (typeof obj.frameRate  === 'number')      obj.frameRate  = 60;
      if (typeof obj.video_fps  === 'number')      obj.video_fps  = 60;
      if (typeof obj.videoFps   === 'number')      obj.videoFps   = 60;
      if (obj.cdn_transcode  != null)              obj.cdn_transcode  = 0;
      if (obj.need_transcode != null)              obj.need_transcode = 0;
      if (obj.is_60_fps      != null)              obj.is_60_fps  = 1;
      if (obj.hfr_type       != null)              obj.hfr_type   = 1;
      if (obj.cloud_edit_is_use_video_canvas)      obj.cloud_edit_is_use_video_canvas = false;

      if (typeof obj.tiktok_snap_shot_lite_params === 'string') {
        obj.tiktok_snap_shot_lite_params = patchSnapshot(obj.tiktok_snap_shot_lite_params);
      }
      if (obj.mediaInfo) {
        if (typeof obj.mediaInfo.fps        === 'number') obj.mediaInfo.fps        = 60;
        if (typeof obj.mediaInfo.frame_rate === 'number') obj.mediaInfo.frame_rate = 60;
      }
      if (obj.metaInfo) {
        if (typeof obj.metaInfo.fps        === 'number') obj.metaInfo.fps        = 60;
        if (typeof obj.metaInfo.frame_rate === 'number') obj.metaInfo.frame_rate = 60;
      }
      // Old method: fix music ID from fused music infos
      if (obj.music_info && obj.music_info.music_id_string) {
        var fused = obj.music_info.fuesd_music_creation_infos ||
                    obj.music_info.fused_music_creation_infos;
        if (fused && fused.length > 0) {
          obj.music_info.music_id_string = String(fused[0].music_id_str || fused[0].music_id);
        }
      }
    } catch (e) {}

    var vals = _origValues(obj);
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i];
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) {
        for (var j = 0; j < v.length; j++) applyParams(v[j], depth + 1);
      } else {
        applyParams(v, depth + 1);
      }
    }
  }

  function tryPatch(obj) {
    if (!active) return;
    if (!isUploadPayload(obj)) return;
    applyParams(obj, 0);
  }

  // ── 1. Hook URL.createObjectURL ────────────────────────────────────────────
  // Video blobs → return 28-byte dummy so TikTok's local analyzer is bypassed
  URL.createObjectURL = function (blob) {
    try {
      if (active && _dummyUrl) {
        var mime = (blob && blob.type) ? blob.type : '';
        if (mime.startsWith('video/') || mime === '') return _dummyUrl;
      }
    } catch (e) {}
    return _origCreateURL(blob);
  };

  // ── 2. Hook JSON.stringify ─────────────────────────────────────────────────
  var hookedStringify = function (value, replacer, space) {
    try {
      if (value && typeof value === 'object') tryPatch(value);
    } catch (e) {}
    return _origStringify.apply(this, arguments);
  };
  try { _origDefProp(hookedStringify, 'length', { value: _origStringify.length }); } catch (e) {}
  try { _origDefProp(hookedStringify, 'name',   { value: 'stringify' });            } catch (e) {}
  hookedStringify.toString = function () { return _origStringify.toString(); };

  try {
    _origDefProp(JSON, 'stringify', {
      value: hookedStringify, writable: true, configurable: true, enumerable: false
    });
  } catch (e) { JSON.stringify = hookedStringify; }

  // Propagate hook into iframes
  try {
    var cwDesc = _origGetDesc(HTMLIFrameElement.prototype, 'contentWindow');
    if (cwDesc && cwDesc.get) {
      _origDefProp(HTMLIFrameElement.prototype, 'contentWindow', {
        get: function () {
          var cw = cwDesc.get.call(this);
          if (!cw) return cw;
          try {
            if (cw.JSON && cw.JSON.stringify !== hookedStringify) {
              _origDefProp(cw.JSON, 'stringify', {
                value: hookedStringify, writable: true, configurable: true, enumerable: false
              });
            }
          } catch (e) {}
          return cw;
        },
        configurable: true, enumerable: true
      });
    }
  } catch (e) {}

  // ── 3. Hook XHR.send ──────────────────────────────────────────────────────
  _origDefProp(XMLHttpRequest.prototype, 'send', {
    value: function (body) {
      if (active && body && typeof body === 'string') {
        try {
          var parsed = _origParse(body);
          if (isUploadPayload(parsed)) {
            tryPatch(parsed);
            return _origXhrSend.call(this, _origStringify(parsed));
          }
        } catch (e) {}
      }
      return _origXhrSend.apply(this, arguments);
    },
    writable: true, configurable: true
  });
  XMLHttpRequest.prototype.send.toString = function () { return _origXhrSend.toString(); };

  // ── 4. Hook fetch ──────────────────────────────────────────────────────────
  window.fetch = function (input, init) {
    if (active && init && typeof init.body === 'string') {
      try {
        var parsed = _origParse(init.body);
        if (isUploadPayload(parsed)) {
          tryPatch(parsed);
          return _origFetch.call(this, input, Object.assign({}, init, { body: _origStringify(parsed) }));
        }
      } catch (e) {}
    }
    return _origFetch.apply(this, arguments);
  };
  window.fetch.toString = function () { return _origFetch.toString(); };

  // ── 5. Auto-set privacy to "Only Me" ──────────────────────────────────────
  var PRIVACY_TEXTS = [
    'only you','only me','private',
    'только я','только вы','sadece sen','nur du','nur ich',
    'solo tú','solo tu','solo yo','seulement toi','moi uniquement',
    'solo te','solo io','apenas você','apenas eu','tylko ty','tylko ja',
    '나만 보기','仅自己','僅自己','自分のみ','hanya saya'
  ];
  var HEADING_TEXTS = [
    'who can see this post','who can view this post',
    'кто может видеть','bu gönderiyi kimler görebilir',
    'wer kann diesen beitrag sehen','qui peut voir cette publication',
    'quién puede ver esta publicación','chi può vedere questo post'
  ];

  function normalize(s) { return (s || '').replace(/\s+/g,' ').trim().toLowerCase(); }

  function matchesPrivacy(txt) {
    var t = normalize(txt);
    if (!t) return false;
    if (t.indexOf('followers') !== -1 || t.indexOf('friends') !== -1) return false;
    for (var i = 0; i < PRIVACY_TEXTS.length; i++) {
      if (t === PRIVACY_TEXTS[i] || t.indexOf(PRIVACY_TEXTS[i]) === 0) return true;
    }
    return false;
  }

  function matchesHeading(txt) {
    var t = normalize(txt);
    for (var i = 0; i < HEADING_TEXTS.length; i++) {
      if (t === HEADING_TEXTS[i] || t.indexOf(HEADING_TEXTS[i]) === 0) return true;
    }
    return false;
  }

  function fireClick(el) {
    try {
      var r = el.getBoundingClientRect();
      var ev = { bubbles:true, cancelable:true, view:window,
                 clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(type) {
        el.dispatchEvent(new MouseEvent(type, ev));
      });
    } catch (e) { try { el.click(); } catch (e2) {} }
  }

  function setPrivacy() {
    if (!active) return;
    var done = false, watcher = null, timeout = null;

    function pickFromList() {
      var items = document.querySelectorAll('.select-option, div[class*="select-option"], [role="option"]');
      for (var i = 0; i < items.length; i++) {
        if (matchesPrivacy(items[i].innerText || items[i].textContent || '')) {
          fireClick(items[i]);
          var inner = items[i].querySelector('span');
          if (inner) fireClick(inner);
          done = true;
          if (watcher) { watcher.disconnect(); watcher = null; }
          if (timeout)  { clearTimeout(timeout); timeout = null; }
          return true;
        }
      }
      return false;
    }

    function findDropdown() {
      var nodes = document.querySelectorAll('.title-v2, span, label, div');
      for (var i = 0; i < nodes.length; i++) {
        if (!matchesHeading(nodes[i].innerText || nodes[i].textContent || '')) continue;
        var el = nodes[i].parentElement;
        for (var hop = 0; hop < 5 && el; hop++) {
          var btn = el.querySelector('button[role="combobox"], [class*="Select__trigger"]');
          if (btn && !btn.querySelector('input[placeholder], [data-icon="Cursor"]')) return btn;
          el = el.parentElement;
        }
      }
      return null;
    }

    function retryPick(left) {
      if (done || left <= 0) return;
      if (pickFromList()) return;
      setTimeout(function() { retryPick(left - 1); }, 200);
    }

    function attempt() {
      if (done) return;
      if (pickFromList()) return;
      var trigger = findDropdown();
      if (!trigger) return;
      var open = trigger.getAttribute('data-open') === 'true' ||
                 trigger.getAttribute('aria-expanded') === 'true';
      if (!open) trigger.click();
      retryPick(15);
    }

    attempt();

    if (!done) {
      var debounce = null;
      watcher = new MutationObserver(function() {
        if (debounce) return;
        debounce = setTimeout(function() { debounce = null; attempt(); }, 400);
      });
      watcher.observe(document.body, { subtree: true, childList: true });
      timeout = setTimeout(function() {
        if (watcher) { watcher.disconnect(); watcher = null; }
        timeout = null;
      }, 60000);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  window.activateBypass = function () {
    active = true;
    setTimeout(setPrivacy, 1500);
    console.log('[bypass] 720p/60fps active');
    return { status: 'ON' };
  };

  window.deactivateBypass = function () {
    active = false;
    console.log('[bypass] deactivated');
    return { status: 'OFF' };
  };

})();

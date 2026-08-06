(function () {
  if (window.__jv1080pInjected) return;
  window.__jv1080pInjected = true;

  // ── URL detector ───────────────────────────────────────────────────────────
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

  // ── Core patch — applied to any TikTok publish payload object ─────────────
  function patchPayload(body) {
    if (!body || typeof body !== 'object') return;

    const hasMusic = !!(
      body.single_post_req_list &&
      body.single_post_req_list[0] &&
      body.single_post_req_list[0].single_post_feature_info &&
      body.single_post_req_list[0].single_post_feature_info.music_info &&
      body.single_post_req_list[0].single_post_feature_info.music_info.music_id_string
    );

    // Remove cloud editing metadata that triggers server re-compression
    ['draft', 'canvas_config', 'vedit_segment_info'].forEach(k => {
      if (body[k] !== undefined) delete body[k];
    });

    // Disable canvas and force direct-upload mode
    if (body.cloud_edit_is_use_video_canvas !== undefined) body.cloud_edit_is_use_video_canvas = false;
    if (body.enter_post_page_from !== undefined)           body.enter_post_page_from = 1;

    // Fix post type and page origin inside post_common_info
    if (body.post_common_info) {
      if (body.post_common_info.post_type !== undefined)           body.post_common_info.post_type = 3;
      if (body.post_common_info.enter_post_page_from !== undefined) body.post_common_info.enter_post_page_from = 1;
    }

    // If promo/music is selected: remove the editor project snapshot so
    // TikTok doesn't re-encode using the cloud editor pipeline
    if (hasMusic && Array.isArray(body.feature_common_info_list)) {
      body.feature_common_info_list.forEach(feature => {
        if (feature && feature.vedit_common_info) {
          if (feature.vedit_common_info.tiktok_snap_shot_lite_params !== undefined) {
            delete feature.vedit_common_info.tiktok_snap_shot_lite_params;
          }
          if (feature.vedit_common_info.application !== undefined) {
            feature.vedit_common_info.application = 1;
          }
        }
      });
    }

    // Per-post cleanup inside single_post_req_list
    if (Array.isArray(body.single_post_req_list)) {
      body.single_post_req_list.forEach(req => {
        const info = req && req.single_post_feature_info;
        if (!info) return;
        if (info.vedit_segment_info !== undefined)          delete info.vedit_segment_info;
        info.has_original_audio              = 1;
        info.cloud_edit_is_use_video_canvas  = false;
      });
    }
  }

  function patchBodyText(text) {
    try {
      const obj = JSON.parse(text);
      patchPayload(obj);
      return JSON.stringify(obj);
    } catch (e) { return text; }
  }

  // ── Hook 1: JSON.stringify ─────────────────────────────────────────────────
  const _origStringify = JSON.stringify;
  JSON.stringify = function (value, replacer, space) {
    if (value && typeof value === 'object') {
      try { patchPayload(value); } catch (e) {}
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

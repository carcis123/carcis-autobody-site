/* Carcis AI review composer -- /review only.
 *
 * The point of this file: typing a paragraph on a phone is the reason people
 * abandon a review. So they talk instead, the browser transcribes it, and the
 * words stay theirs. Nothing here writes a review for anyone.
 *
 * The button takes either gesture, because people split roughly down the
 * middle on which one they try first and being wrong costs them the recording:
 *   hold it down  -> talks while held, stops on release (walkie-talkie)
 *   tap it once   -> stays listening until tapped again (hands free)
 * A press shorter than HOLD_MS is read as a tap. Keyboard gets a plain toggle.
 *
 * The optional "tidy up" step sends what they said to /api/review-polish and
 * shows the result BESIDE their original, with their own version kept unless
 * they pick the other one. It only ever fixes wording. It never adds a fact,
 * an opinion or a feeling that was not already in what they said, and a
 * review that complains about us has to come back still complaining about us.
 *
 * Google has no way to prefill the text in its review box -- there is no URL
 * parameter for it and never has been. So the last step copies to the
 * clipboard and opens Google, and the page tells them to paste. That paste is
 * unavoidable; pretending otherwise just means they land on Google confused.
 */
(function () {
  var root = document.getElementById('composer');
  if (!root) return;

  var box       = document.getElementById('cpText');
  var micBtn    = document.getElementById('cpMic');
  var micLabel  = document.getElementById('cpMicLabel');
  var micHint   = document.getElementById('cpMicHint');
  var statusEl  = document.getElementById('cpStatus');
  var countEl   = document.getElementById('cpCount');
  var polishBtn = document.getElementById('cpPolish');
  var compare   = document.getElementById('cpCompare');
  var tidiedEl  = document.getElementById('cpTidied');
  var useMine   = document.getElementById('cpUseMine');
  var useTidied = document.getElementById('cpUseTidied');
  var goBtn     = document.getElementById('cpGo');
  var doneEl    = document.getElementById('cpDone');
  var doneHead  = doneEl ? doneEl.querySelector('.cp-done-head') : null;

  var POLISH_URL = root.getAttribute('data-polish') || '';
  var HOLD_MS = 500;

  function track(name) {
    try { if (window.clarity) window.clarity('event', name); } catch (e) {}
    try { if (window.gtag) window.gtag('event', name); } catch (e) {}
  }

  function say(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'cp-status' + (kind ? ' cp-status-' + kind : '');
  }

  /* ----------------------------------------------------------- word count */

  function words(s) {
    var t = (s || '').trim();
    return t ? t.split(/\s+/).length : 0;
  }

  function refresh() {
    var n = words(box.value);
    countEl.textContent = n === 0 ? '' : n + (n === 1 ? ' word' : ' words');
    // Two sentences is what the page asks for, so about 15 words is the point
    // where it is worth posting. Encouragement, never a gate.
    countEl.className = 'cp-count' + (n >= 15 ? ' cp-count-ok' : '');
    goBtn.classList.toggle('cp-go-off', n === 0);
    if (polishBtn) polishBtn.disabled = n < 8;
  }

  /* ------------------------------------------------------- level meter --
     A real meter off the microphone, so "is it hearing me?" is answered by
     the microphone itself rather than by an animation that would wave about
     just as convincingly if the mic were dead. Entirely optional: if the
     audio stream is refused or unavailable, the ring falls back to a timed
     pulse and dictation is unaffected. */

  var media = null, audioCtx = null, analyser = null, rafId = 0, buf = null;

  function openMeter() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      // The user may have stopped talking while the prompt was up.
      if (!listening) { stopTracks(stream); return; }
      media = stream;
      audioCtx = new AC();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
      micBtn.classList.add('cp-mic-metered');
      meter();
    }).catch(function () {
      // No meter. The pulse keeps doing its job.
    });
  }

  function meter() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var d = (buf[i] - 128) / 128;
      sum += d * d;
    }
    // Speech sits low in this range, so it is scaled up and clamped rather
    // than shown raw, where normal talking would barely move the ring.
    var level = Math.min(1, Math.sqrt(sum / buf.length) * 5.5);
    micBtn.style.setProperty('--level', level.toFixed(3));
    rafId = requestAnimationFrame(meter);
  }

  function stopTracks(stream) {
    try {
      stream.getTracks().forEach(function (t) { t.stop(); });
    } catch (e) {}
  }

  function closeMeter() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    // Release the microphone properly. Leaving the tracks open keeps the
    // browser's recording indicator lit after the customer has stopped
    // talking, which is alarming and fair enough.
    if (media) { stopTracks(media); media = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyser = null;
    buf = null;
    micBtn.classList.remove('cp-mic-metered');
    micBtn.style.setProperty('--level', '0');
  }

  /* ----------------------------------------------------------- dictation */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null;
  var listening = false;
  var wantListening = false;   // the user's intent, separate from engine state
  var committed = '';          // everything finalised or typed
  var interim = '';
  var mode = 'hold';           // 'hold' while held down, 'toggle' after a tap
  var pressedAt = 0;
  var ignoreNextUp = false;

  function paint() {
    var joined = committed + (interim ? ' ' + interim : '');
    box.value = joined.replace(/\s+/g, ' ').replace(/^\s+/, '');
    refresh();
  }

  function labels() {
    if (listening) {
      micLabel.textContent = 'Listening';
      micHint.textContent = mode === 'hold' ? 'Let go when you’re done' : 'Tap again to stop';
    } else {
      micLabel.textContent = committed ? 'Hold to add more' : 'Hold to talk';
      micHint.textContent = 'or tap once and it keeps listening';
    }
  }

  function setMic(on) {
    listening = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.classList.toggle('cp-mic-live', on);
    labels();
  }

  if (!SR) {
    // No speech engine: Firefox, and some iOS versions. The textarea is the
    // whole feature then, so get out of its way rather than leaving a big
    // button on screen that cannot work.
    micBtn.hidden = true;
    say('Talking isn’t supported in this browser, so type it below — it works the same from there.');
  } else {
    micBtn.addEventListener('pointerdown', onDown);
    micBtn.addEventListener('pointerup', onUp);
    micBtn.addEventListener('pointercancel', onUp);
    // A pointer that leaves the button mid-hold still counts as a release,
    // otherwise a finger sliding off a phone button leaves it stuck live.
    micBtn.addEventListener('pointerleave', onUp);
    // Pointer events already handled it; stop the synthetic click doubling up.
    micBtn.addEventListener('click', function (e) { e.preventDefault(); });
    micBtn.addEventListener('keydown', onKey);
  }

  function onDown(e) {
    e.preventDefault();
    if (listening) {
      // Second press of a tapped-on session: stop, and do not let the
      // matching release start it again.
      ignoreNextUp = true;
      endListening();
      return;
    }
    ignoreNextUp = false;
    pressedAt = Date.now();
    mode = 'hold';
    try { if (e.pointerId != null) micBtn.setPointerCapture(e.pointerId); } catch (err) {}
    beginListening();
  }

  function onUp(e) {
    if (e && e.pointerId != null) {
      try { micBtn.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    if (ignoreNextUp) { ignoreNextUp = false; return; }
    if (!listening) return;

    if (Date.now() - pressedAt < HOLD_MS) {
      // Too quick to be a hold, so they meant it as a tap. Keep going.
      mode = 'toggle';
      labels();
      say('Listening. Say it how you’d say it to a friend — pauses are fine. Tap again when you’re done.', 'live');
      return;
    }
    endListening();
  }

  function onKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    if (listening) { endListening(); return; }
    // Holding a key down is not a gesture anyone makes deliberately, so the
    // keyboard gets the plain toggle.
    mode = 'toggle';
    beginListening();
  }

  function beginListening() {
    committed = box.value.trim();
    interim = '';
    wantListening = true;
    start();
    track('review_voice_start');
  }

  function endListening() {
    wantListening = false;
    setMic(false);
    closeMeter();
    if (rec) { try { rec.stop(); } catch (e) {} }
    say(box.value.trim() ? 'Read it back and change anything that isn’t how you’d say it.' : '');
  }

  function start() {
    rec = new SR();
    rec.lang = document.documentElement.lang || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = function () {
      setMic(true);
      openMeter();
      say(mode === 'hold'
        ? 'Listening. Say it how you’d say it to a friend — pauses are fine.'
        : 'Listening. Say it how you’d say it to a friend — pauses are fine. Tap again when you’re done.',
        'live');
    };

    rec.onresult = function (e) {
      var pending = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          committed = (committed + ' ' + chunk.replace(/^\s+|\s+$/g, '')).replace(/^\s+/, '');
        } else {
          pending += chunk;
        }
      }
      interim = pending.replace(/^\s+|\s+$/g, '');
      paint();
    };

    rec.onerror = function (e) {
      var code = e.error || '';
      wantListening = false;
      setMic(false);
      closeMeter();
      interim = '';
      paint();

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        say('The browser blocked the microphone. Allow it from the address bar, or just type below.', 'warn');
      } else if (code === 'no-speech') {
        say('Didn’t catch anything. Hold the button again and speak up, or type below.', 'warn');
      } else if (code === 'audio-capture') {
        say('No microphone found. Typing below works just as well.', 'warn');
      } else if (code === 'aborted') {
        say('');
      } else {
        say('Speech recognition stopped working. You can carry on typing below.', 'warn');
      }
    };

    rec.onend = function () {
      // Chrome ends the session by itself after a pause. While the button is
      // still held or still tapped on, restart, so a long pause mid-thought
      // does not quietly end the dictation.
      if (wantListening) {
        try { rec.start(); return; } catch (e) {}
      }
      setMic(false);
      closeMeter();
      if (interim) {
        committed = (committed + ' ' + interim).replace(/^\s+/, '');
        interim = '';
      }
      paint();
    };

    try {
      rec.start();
    } catch (e) {
      wantListening = false;
      setMic(false);
      closeMeter();
      say('Couldn’t start the microphone. Type it below instead.', 'warn');
    }
  }

  // A manual edit becomes the new baseline, so dictating again appends to the
  // edited text rather than resurrecting what was replaced.
  box.addEventListener('input', function () {
    if (!listening) { committed = box.value; interim = ''; labels(); }
    refresh();
    if (compare) compare.hidden = true;
    if (doneEl) doneEl.hidden = true;
  });

  /* ------------------------------------------------------------- tidy up */

  if (polishBtn && POLISH_URL) {
    polishBtn.addEventListener('click', function () {
      var mine = box.value.trim();
      if (words(mine) < 8) return;

      polishBtn.disabled = true;
      polishBtn.textContent = 'Thinking…';
      say('');

      fetch(POLISH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: mine })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      }).then(function (r) {
        var sent = r.data && typeof r.data.polished === 'string';
        if (!r.ok || !sent) throw new Error('unavailable');
        // An empty string is a deliberate answer, not a failure: the endpoint
        // checked the edit, decided it had drifted from what the customer
        // actually said, and withheld it. Saying "couldn't reach the service"
        // there would be a lie about something that worked correctly.
        var tidied = r.data.polished.trim();
        if (!tidied || tidied === mine) {
          say('Carcis AI didn’t find anything worth changing — it already reads well.', 'ok');
          return;
        }
        tidiedEl.textContent = tidied;
        compare.hidden = false;
        say('');
        track('review_polish');
        compare.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }).catch(function () {
        say('Couldn’t reach Carcis AI. What you’ve written is fine as it is — carry on.', 'warn');
      }).then(function () {
        polishBtn.textContent = 'Ask Carcis AI to tidy it up';
        refresh();
      });
    });

    useTidied.addEventListener('click', function () {
      committed = tidiedEl.textContent;
      interim = '';
      paint();
      compare.hidden = true;
      say('Using the tidied version. Edit it freely — it’s your review.', 'ok');
    });

    useMine.addEventListener('click', function () {
      compare.hidden = true;
      say('Keeping your own words.', 'ok');
    });
  } else if (polishBtn) {
    polishBtn.hidden = true;
  }

  /* -------------------------------------------------- copy and hand over */

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Older Safari, and any non-secure context.
    return new Promise(function (resolve, reject) {
      var tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.position = 'fixed';
      tmp.style.top = '-1000px';
      document.body.appendChild(tmp);
      tmp.select();
      tmp.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(tmp);
      if (ok) { resolve(); } else { reject(new Error('copy failed')); }
    });
  }

  // goBtn is a real link, so the new tab opens from the click itself and
  // cannot be swallowed by a popup blocker. The copy rides along beside it.
  goBtn.addEventListener('click', function (e) {
    var text = box.value.trim();
    if (!text) { e.preventDefault(); box.focus(); return; }

    copy(text).then(function () {
      doneEl.hidden = false;
      if (doneHead) doneHead.textContent = 'Copied. Now paste it into the box on Google.';
    }).catch(function () {
      doneEl.hidden = false;
      if (doneHead) {
        doneHead.textContent = 'Couldn’t copy it for you — select the text above and copy it yourself.';
      }
      box.select();
    });

    track('review_copy_open');
  });

  // The microphone must not stay open because someone wandered off mid-review.
  window.addEventListener('pagehide', function () { wantListening = false; closeMeter(); });

  refresh();
  setMic(false);
})();

/* Carcis AI review composer -- /review only.
 *
 * The point of this file: typing a paragraph on a phone is the reason people
 * abandon a review. So they talk instead, the browser transcribes it, and the
 * words stay theirs. Nothing here writes a review for anyone.
 *
 * The button is a plain toggle: press to start, press again to stop. It was
 * a hold gesture first, and the hold caused most of its faults, so it went.
 *
 * Transcription is the browser's Web Speech API. Worth being clear-eyed
 * about where the audio goes: in Chrome this is NOT on-device -- Chrome
 * streams the microphone to Google's speech service and returns text, and
 * Safari does the same with Apple. None of it reaches Carcis, and this file
 * never records, stores or uploads anything itself, but the page must not
 * tell people their voice stayed on their phone, because in Chrome it did
 * not. It also means recognition needs a working network connection: on a
 * weak signal it returns nothing and looks broken.
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
  var liveEl    = document.getElementById('cpLive');
  var liveDone  = document.getElementById('cpLiveDone');
  var liveNow   = document.getElementById('cpLiveNow');
  var goBtn     = document.getElementById('cpGo');
  var doneEl    = document.getElementById('cpDone');
  var doneHead  = doneEl ? doneEl.querySelector('.cp-done-head') : null;

  var POLISH_URL = root.getAttribute('data-polish') || '';

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
  // Shared by openMeter and startStream. Kept here rather than inside
  // openMeter so splitting the two apart cannot leave startStream reaching
  // for a name it cannot see -- which is exactly what happened once, and the
  // meter's own catch block swallowed the ReferenceError without a word.
  var AC = window.AudioContext || window.webkitAudioContext;

  function openMeter() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (!AC) return;

    // Only ask for the audio stream when the microphone has ALREADY been
    // granted. Asking during a live session raises a second permission
    // prompt, and that prompt can abort the speech recognition that just
    // started -- the meter is a nicety, and it is not worth costing someone
    // the recording they were in the middle of making. Without the
    // Permissions API we simply do without the meter.
    if (!navigator.permissions || !navigator.permissions.query) return;

    navigator.permissions.query({ name: 'microphone' }).then(function (status) {
      if (status.state !== 'granted' || !listening) return;
      return startStream();
    }).catch(function () {
      // Firefox and some Safari builds reject the 'microphone' descriptor
      // outright. No meter, no harm.
    });
  }

  function startStream() {
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
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
    }).catch(function (err) {
      // No meter. The pulse keeps doing its job. Logged rather than
      // swallowed: a refused stream and a mistake in this file look
      // identical from the outside otherwise.
      if (window.console && console.warn) console.warn('review: level meter off -', err && err.message);
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

  function paint() {
    var joined = committed + (interim ? ' ' + interim : '');
    box.value = joined.replace(/\s+/g, ' ').replace(/^\s+/, '');
    caption();
    refresh();
  }

  /* While someone is holding the button their own hand covers the lower half
     of the screen and the textarea is often below the fold, so words landing
     in it prove nothing. The caption repeats the tail of the transcript
     directly under the button, where they are already looking. It is the
     honest version of a "listening" animation: it can only move if the
     recogniser is actually returning words. */
  function caption() {
    if (!liveEl) return;
    if (!listening) { liveEl.hidden = true; return; }

    var done = committed.replace(/^\s+/, '');
    var TAIL = 90;
    if (done.length > TAIL) done = '…' + done.slice(-TAIL);

    liveEl.hidden = false;
    liveDone.textContent = done;
    liveNow.textContent = interim ? (done ? ' ' : '') + interim : '';
    liveEl.classList.toggle('cp-live-empty', !done && !interim);

    // Once their own words are on screen, anything the status line was
    // saying is stale: the opening prompt has done its job, and a "not
    // picking anything up" warning is now flatly contradicted by the text
    // appearing underneath it. Clear it either way.
    if (done || interim) say('');
  }

  function labels() {
    if (listening) {
      micLabel.textContent = 'Listening';
      micHint.textContent = 'Press again when you’re done';
    } else {
      micLabel.textContent = committed ? 'Press to add more' : 'Press to talk';
      micHint.textContent = 'press again to stop';
    }
  }

  function setMic(on) {
    listening = on;
    micBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    micBtn.classList.toggle('cp-mic-live', on);
    root.classList.toggle('cp-is-live', on);
    labels();
    caption();
  }

  if (!SR) {
    // No speech engine: Firefox, and some iOS versions. The textarea is the
    // whole feature then, so get out of its way rather than leaving a big
    // button on screen that cannot work.
    micBtn.hidden = true;
    say('Talking isn’t supported in this browser, so type it below — it works the same from there.');
  } else {
    // One plain click handler: press to start, press again to stop.
    //
    // This used to be a hold gesture built on pointer events, and the hold
    // was the source of most of its faults -- a thumb drifting off a round
    // button, capture behaving differently per browser, and a synthetic
    // click arriving behind every press. A button that toggles needs none of
    // that, works identically under touch, mouse, keyboard and screen
    // reader, and cannot end a recording because someone's finger moved.
    micBtn.addEventListener('click', function () {
      if (listening) { endListening(); } else { beginListening(); }
    });
  }

  /* Android Chrome ignores `continuous` and ends the session after a single
     utterance, so the restart below is what makes dictation feel continuous
     there rather than a nicety. It is also why a restart loop has to be
     guarded: if the engine ends immediately and repeatedly without ever
     returning a word, restarting forever would hammer the microphone and
     leave the button looking live while nothing happens. */
  var results = 0;      // results returned in this session
  var restarts = 0;     // consecutive restarts with nothing to show for them
  var MAX_DEAD_RESTARTS = 4;
  var watchId = 0;

  // Nothing heard for a while is the single most confusing failure, because
  // the button looks alive. Say so rather than leaving someone talking at a
  // phone that is not listening.
  function watchdog() {
    clearTimeout(watchId);
    watchId = setTimeout(function () {
      if (listening && results === 0) {
        say('Not picking anything up yet. Check the microphone is allowed for this site, and that you have a signal — or just type it below.', 'warn');
      }
    }, 7000);
  }

  function beginListening() {
    committed = box.value.trim();
    interim = '';
    results = 0;
    restarts = 0;
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
      say('Listening. Say it how you’d say it to a friend — pauses are fine. Press again when you’re done.', 'live');
      watchdog();
    };

    rec.onresult = function (e) {
      results++;
      restarts = 0;
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
      clearTimeout(watchId);
      // Android fires no-speech constantly during ordinary pauses. Ending
      // the session on it would stop someone mid-thought every time they
      // drew breath, so it is left to onend's restart instead.
      if (code === 'no-speech' && wantListening) return;
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
      // Chrome ends the session by itself after a pause, and Android Chrome
      // ends it after every single utterance. While the button is still on,
      // start a fresh recogniser so a pause mid-thought does not quietly end
      // the dictation. A brand new object rather than restarting the old one:
      // Android throws InvalidStateError on reusing a stopped recogniser.
      if (wantListening) {
        if (results > 0) restarts = 0; else restarts++;
        if (restarts <= MAX_DEAD_RESTARTS) {
          setTimeout(function () { if (wantListening) start(); }, 120);
          return;
        }
        // It has ended several times running without ever returning a word.
        // Something is wrong that restarting will not fix.
        wantListening = false;
        say('The microphone keeps dropping out. That is usually permission or signal — type it below and you will not lose anything.', 'warn');
      }
      clearTimeout(watchId);
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

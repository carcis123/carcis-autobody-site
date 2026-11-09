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
  var waveEl    = document.getElementById('cpWave');
  var liveEl    = document.getElementById('cpLive');
  var liveDone  = document.getElementById('cpLiveDone');
  var liveNow   = document.getElementById('cpLiveNow');
  var goBtn     = document.getElementById('cpGo');
  var doneEl    = document.getElementById('cpDone');
  var doneHead  = doneEl ? doneEl.querySelector('.cp-done-head') : null;

  var POLISH_URL = root.getAttribute('data-polish') || '';
  // Read from the stylesheet rather than hard-coded, so the wave cannot
  // drift away from the rest of the page's colour the next time it moves.
  var WAVE_COLOR = (getComputedStyle(root).getPropertyValue('--cp-wave') || '').trim() || '#e23b3b';

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
  var AC = window.AudioContext || window.webkitAudioContext;
  var waveCtx = null, waveW = 0, waveH = 0;

  /* The stream is opened BEFORE speech recognition starts, from the click
     itself, so there is one permission prompt and it is answered before
     anything else begins. The old order asked for it midway through a live
     session, which could kill the session it was decorating, and so it only
     ran when permission was already granted -- meaning on a first visit, when
     reassurance matters most, there was none. */
  function openMeter() {
    if (media) return Promise.resolve(true);          // restart: already open
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC) {
      return Promise.resolve(false);
    }
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (!wantListening) { stopTracks(stream); return false; }
      media = stream;
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      buf = new Uint8Array(analyser.fftSize);
      micBtn.classList.add('cp-mic-metered');
      if (waveEl) { waveEl.hidden = false; sizeWave(); }
      meter();
      return true;
    }).catch(function (err) {
      if (window.console && console.warn) console.warn('review: no level meter -', err && err.name, err && err.message);
      return false;
    });
  }

  function sizeWave() {
    if (!waveEl) return;
    var dpr = window.devicePixelRatio || 1;
    var r = waveEl.getBoundingClientRect();
    if (!r.width) return;
    waveW = Math.round(r.width); waveH = Math.round(r.height);
    waveEl.width = Math.round(waveW * dpr);
    waveEl.height = Math.round(waveH * dpr);
    waveCtx = waveEl.getContext('2d');
    waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* A real trace off the microphone, not an animation. The distinction
     matters: a decorative wave would wave just as convincingly with the mic
     dead, which is precisely the question someone staring at this button is
     asking. If the stream is refused there is no wave at all, rather than a
     comforting one. */
  function drawWave() {
    if (!waveCtx || !analyser) return;
    var w = waveW, h = waveH, mid = h / 2;
    waveCtx.clearRect(0, 0, w, h);

    var BAR = 4, GAP = 3, step = BAR + GAP;
    var bars = Math.max(1, Math.floor(w / step));
    var per = Math.floor(buf.length / bars) || 1;

    waveCtx.fillStyle = WAVE_COLOR;
    for (var b = 0; b < bars; b++) {
      var sum = 0, n = 0;
      for (var i = b * per; i < (b + 1) * per && i < buf.length; i++) {
        var d = (buf[i] - 128) / 128;
        sum += d * d; n++;
      }
      var amp = Math.min(1, Math.sqrt(sum / (n || 1)) * 4.5);
      // Always at least a hairline, so the strip reads as a quiet microphone
      // rather than as a broken one.
      var bh = Math.max(3, amp * (h - 6));
      waveCtx.globalAlpha = 0.45 + amp * 0.55;
      waveCtx.fillRect(b * step, mid - bh / 2, BAR, bh);
    }
    waveCtx.globalAlpha = 1;
  }

  function meter() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    var sum = 0;
    for (var i = 0; i < buf.length; i++) {
      var d = (buf[i] - 128) / 128;
      sum += d * d;
    }
    var level = Math.min(1, Math.sqrt(sum / buf.length) * 5.5);
    micBtn.style.setProperty('--level', level.toFixed(3));
    drawWave();
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
    if (waveEl) { waveEl.hidden = true; if (waveCtx) waveCtx.clearRect(0, 0, waveW, waveH); }
  }

  window.addEventListener('resize', function () { if (analyser) sizeWave(); });

  /* ----------------------------------------------------------- dictation */

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* The recogniser's language has to be a full tag with a region.
     document.documentElement.lang here is "en", and Google's speech service
     rejects a bare "en" outright -- not with language-not-supported, which
     would have said what was wrong, but with a `network` error about half a
     second in. That one line is what made this look like a broken microphone,
     a flaky Android, and a dead feature on the desktop too. The site is one
     shop in Vancouver WA, so en-US is the honest default; the map is here so
     that adding a Spanish page later is a one-line change rather than this
     bug again. */
  var LANG_REGION = { en: 'en-US', es: 'es-US', ru: 'ru-RU', uk: 'uk-UA', vi: 'vi-VN' };
  var SPEECH_LANG = (function () {
    var tag = (document.documentElement.lang || '').trim();
    if (/^[a-z]{2,3}-[A-Za-z0-9]{2,}/.test(tag)) return tag;       // already regioned
    return LANG_REGION[tag.toLowerCase()] || 'en-US';
  })();
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
  var grantId = 0;
  var meterDropped = false;   // the wave was given up to free the microphone
  var listeningStarted = false;  // the engine has actually begun

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

  // Move anything still provisional into the permanent transcript. Called on
  // every end, restart included, because an utterance that was heard must not
  // depend on a final result arriving to survive.
  function keep() {
    if (!interim) return;
    committed = (committed + ' ' + interim).replace(/^\s+/, '');
    interim = '';
  }

  function beginListening() {
    committed = box.value.trim();
    interim = '';
    results = 0;
    restarts = 0;
    listeningStarted = false;
    meterDropped = false;
    wantListening = true;
    // Visual feedback on the press itself. Waiting for the engine's onstart
    // leaves the button looking dead for as long as a permission prompt is
    // up, which is exactly when someone decides it is broken.
    setMic(true);
    say('Starting…', 'live');
    // The microphone first, so there is one prompt and it is settled before
    // recognition begins. Recognition starts either way: a refused stream
    // costs the wave, not the dictation.
    //
    // Nothing can happen until that prompt is answered, so say what we are
    // waiting for. Tested on a fresh origin, the button otherwise sat on
    // \"Starting…\" indefinitely while the browser's own dialog waited
    // off to one side, which reads as the feature hanging.
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'microphone' }).then(function (st) {
        if (st.state === 'prompt' && wantListening && !media) {
          say('Allow the microphone when your browser asks — nothing is recorded or sent to us.', 'live');
        }
      }).catch(function () {});
    }
    // And if it is never answered, do not sit there forever.
    clearTimeout(grantId);
    grantId = setTimeout(function () {
      if (wantListening && !media && !listeningStarted) {
        wantListening = false;
        setMic(false);
        closeMeter();
        say('The microphone was never allowed, so there is nothing to listen with. Type it below instead — it works the same.', 'warn');
      }
    }, 20000);
    openMeter().then(startSpeech, startSpeech);
    track('review_voice_start');
  }

  function startSpeech() { clearTimeout(grantId); if (wantListening) start(); else closeMeter(); }

  function endListening() {
    wantListening = false;
    listeningStarted = false;
    clearTimeout(grantId);
    setMic(false);
    closeMeter();
    if (rec) { try { rec.stop(); } catch (e) {} }
    say(box.value.trim() ? 'Read it back and change anything that isn’t how you’d say it.' : '');
  }

  function start() {
    rec = new SR();
    rec.lang = SPEECH_LANG;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onstart = function () {
      listeningStarted = true;
      clearTimeout(grantId);
      setMic(true);
      if (!committed && !interim) {
        say('Listening. Say it how you’d say it to a friend — pauses are fine. Press again when you’re done.', 'live');
      }
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

      // Logged every time. The fault that cost two rounds of this feature was
      // a `network` error reported to the customer as \"stopped working\", with
      // the actual code visible nowhere -- so there was nothing to go on but
      // guesswork. The code goes to the console now, always.
      if (window.console && console.warn) console.warn('review: speech error -', code, e.message || '');

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        say('The browser blocked the microphone. Allow it from the address bar, or just type below.', 'warn');
      } else if (code === 'no-speech') {
        say('Didn’t catch anything. Press the button again and speak up, or type below.', 'warn');
      } else if (code === 'audio-capture') {
        say('No microphone found. Typing below works just as well.', 'warn');
      } else if (code === 'network') {
        // Transcription happens on Google's servers, not on the phone, so
        // this is a connection problem and worth saying plainly rather than
        // leaving someone pressing a button that will not work.
        say(media
          ? 'Your microphone is working, but the words can’t get to the transcription service — that needs a connection. Type it below instead.'
          : 'Couldn’t reach the transcription service. Check your connection, or type it below instead.', 'warn');
      } else if (code === 'aborted') {
        say('');
      } else {
        say('Speech recognition stopped (' + (code || 'unknown') + '). You can carry on typing below.', 'warn');
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
          // Bank whatever is still pending BEFORE restarting. Android Chrome
          // ends the session after every utterance, frequently with the last
          // words still interim and no final behind them; the restart used to
          // return straight past this and the next session's first result
          // overwrote `interim`, so each utterance quietly destroyed the one
          // before it. Desktop almost always sends a final before ending,
          // which is why this only ever showed up on a phone -- words
          // appearing on screen and then no text in the box at the end.
          keep();
          // Two dead sessions in a row with the wave's audio stream open is
          // the signature of the microphone being held against the
          // recogniser. It is NOT what happens on this desktop -- measured
          // on the live page, holding the stream is what made transcription
          // work at all there -- but a phone arbitrates a second capture
          // differently and I have no way to test that from here. So rather
          // than pick a side, give the stream up and carry on without it.
          // The wave is worth having; it is not worth the words.
          if (results === 0 && media && !meterDropped && restarts >= 2) {
            meterDropped = true;
            closeMeter();
            if (window.console && console.warn) {
              console.warn('review: no results with the meter open - dropping it and retrying without');
            }
          }
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
      keep();
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

(function () {
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Scroll reveal
  var revealEls = document.querySelectorAll('.reveal');
  if (revealEls.length) {
    if (reduceMotion) {
      revealEls.forEach(function (el) { el.classList.add('in'); });
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry, i) {
          if (entry.isIntersecting) {
            setTimeout(function () { entry.target.classList.add('in'); }, i * 40);
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });
      revealEls.forEach(function (el) { io.observe(el); });
    }
  }

  // Mobile nav
  var toggle = document.getElementById('navToggle');
  var mobile = document.getElementById('navMobile');
  var closeBtn = document.getElementById('navClose');
  if (toggle && mobile) {
    var FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

    function focusableItems() {
      return Array.prototype.filter.call(
        mobile.querySelectorAll(FOCUSABLE),
        function (el) { return el.offsetParent !== null || el === document.activeElement; }
      );
    }

    function openNav() {
      mobile.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      var items = focusableItems();
      if (items.length) items[0].focus();
      document.addEventListener('keydown', onKeydown);
    }

    function closeNav() {
      mobile.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKeydown);
      toggle.focus();
    }

    // Escape closes the menu; Tab is trapped inside it while it is open, so
    // keyboard focus cannot wander onto the page hidden behind the overlay.
    function onKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        closeNav();
        return;
      }
      if (e.key !== 'Tab') return;
      var items = focusableItems();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    toggle.addEventListener('click', openNav);
    if (closeBtn) closeBtn.addEventListener('click', closeNav);
    mobile.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeNav); });
  }

  // Before/after slider (Home + Estimate pages)
  var frame = document.getElementById('sliderFrame');
  var input = document.getElementById('sliderInput');
  if (frame && input) {
    function setSplit(pct) {
      pct = Math.max(0, Math.min(100, pct));
      frame.style.setProperty('--split', pct + '%');
      input.value = pct;
    }
    input.addEventListener('input', function () { setSplit(parseFloat(input.value)); });

    var dragging = false;
    function pctFromClientX(clientX) {
      var rect = frame.getBoundingClientRect();
      return ((clientX - rect.left) / rect.width) * 100;
    }
    frame.addEventListener('pointerdown', function (e) {
      dragging = true;
      setSplit(pctFromClientX(e.clientX));
    });
    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      setSplit(pctFromClientX(e.clientX));
    });
    window.addEventListener('pointerup', function () { dragging = false; });

    if (!reduceMotion) {
      var t0 = null;
      function introSweep(ts) {
        if (t0 === null) t0 = ts;
        var elapsed = ts - t0;
        var dur = 1400;
        if (elapsed < dur) {
          var p = elapsed / dur;
          var eased = 1 - Math.pow(1 - p, 3);
          setSplit(eased * 62);
          requestAnimationFrame(introSweep);
        } else {
          setSplit(50);
        }
      }
      setTimeout(function () { requestAnimationFrame(introSweep); }, 500);
    } else {
      setSplit(50);
    }
  }

  // Photo lightbox. Any <a class="lb-item"> opens its image large, and links
  // sharing a data-lb group can be paged through with the arrow buttons, the
  // arrow keys, or a swipe. Built on <dialog>, which supplies the modal focus
  // handling and Escape to close. Without JavaScript, or in a browser without
  // <dialog>, the link simply opens the image file.
  if (document.querySelector('a.lb-item') && typeof HTMLDialogElement === 'function') {
    var lb = null;
    var lbImg, lbRole, lbText, lbLink, lbCount, lbPrev, lbNext, lbStage, lbClose;
    var lbGroup = [];
    var lbIndex = 0;
    var lbOpener = null;
    var lbSwiped = false;

    function lbIcon(d) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
        + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
    }

    function buildLightbox() {
      lb = document.createElement('dialog');
      lb.className = 'lb';
      lb.setAttribute('aria-label', 'Photo viewer');
      lb.innerHTML =
        '<div class="lb-bar">'
        + '<span class="lb-count" aria-live="polite"></span>'
        + '<button type="button" class="lb-btn lb-close" aria-label="Close">' + lbIcon('M6 6l12 12M18 6L6 18') + '</button>'
        + '</div>'
        + '<div class="lb-stage">'
        + '<button type="button" class="lb-btn lb-prev" aria-label="Previous photo">' + lbIcon('M15 6l-6 6 6 6') + '</button>'
        + '<img class="lb-img" alt="">'
        + '<button type="button" class="lb-btn lb-next" aria-label="Next photo">' + lbIcon('M9 6l6 6-6 6') + '</button>'
        + '</div>'
        + '<p class="lb-caption"><span class="lb-role"></span><span class="lb-text"></span>'
        + '<a class="lb-link" href="#"></a></p>';
      document.body.appendChild(lb);

      lbImg = lb.querySelector('.lb-img');
      lbRole = lb.querySelector('.lb-role');
      lbText = lb.querySelector('.lb-text');
      lbLink = lb.querySelector('.lb-link');
      lbCount = lb.querySelector('.lb-count');
      lbPrev = lb.querySelector('.lb-prev');
      lbNext = lb.querySelector('.lb-next');
      lbStage = lb.querySelector('.lb-stage');
      lbClose = lb.querySelector('.lb-close');

      lbClose.addEventListener('click', closeLightbox);
      lbPrev.addEventListener('click', function () { showPhoto(lbIndex - 1); });
      lbNext.addEventListener('click', function () { showPhoto(lbIndex + 1); });
      lbImg.addEventListener('load', function () { lb.classList.remove('lb-loading'); });
      // Escape: take over the browser's own close, so every way out of the
      // viewer runs the same synchronous cleanup. If the browser closes the
      // dialog anyway, the close event is the backstop, and it ignores a stale
      // event that arrives after the viewer has already been reopened.
      lb.addEventListener('cancel', function (e) { e.preventDefault(); closeLightbox(); });
      lb.addEventListener('close', function () { if (!lb.open) onLightboxClosed(); });

      // Keys are read from e.key. Escape is handled here as well as through the
      // cancel event: the browser's own dialog handling decides on the legacy
      // key code, which some input tooling does not send, and closing from
      // here keeps every exit on the same synchronous cleanup.
      lb.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); showPhoto(lbIndex - 1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); showPhoto(lbIndex + 1); }
        else if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); closeLightbox(); }
      });

      // Clicking the dark area around the photo closes the viewer.
      lbStage.addEventListener('click', function (e) {
        if (lbSwiped) { lbSwiped = false; return; }
        if (e.target === lbStage) closeLightbox();
      });

      // A horizontal swipe pages; a mostly vertical one is left for scrolling.
      var startX = null;
      var startY = null;
      lbStage.addEventListener('pointerdown', function (e) { startX = e.clientX; startY = e.clientY; });
      lbStage.addEventListener('pointerup', function (e) {
        if (startX === null) return;
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        startX = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) && lbGroup.length > 1) {
          lbSwiped = true;
          showPhoto(lbIndex + (dx < 0 ? 1 : -1));
        }
      });
    }

    function showPhoto(i) {
      if (!lbGroup.length) return;
      lbIndex = (i + lbGroup.length) % lbGroup.length;
      var a = lbGroup[lbIndex];

      lb.classList.add('lb-loading');
      lbImg.alt = a.getAttribute('data-lb-caption') || '';
      if (a.getAttribute('data-lb-w')) {
        lbImg.width = parseInt(a.getAttribute('data-lb-w'), 10);
        lbImg.height = parseInt(a.getAttribute('data-lb-h'), 10);
      }
      lbImg.src = a.getAttribute('href');
      if (lbImg.complete && lbImg.naturalWidth) lb.classList.remove('lb-loading');

      lbRole.textContent = a.getAttribute('data-lb-role') || '';
      lbRole.hidden = !lbRole.textContent;
      lbText.textContent = a.getAttribute('data-lb-caption') || '';

      var link = a.getAttribute('data-lb-link');
      if (link) {
        lbLink.href = link;
        lbLink.textContent = 'See the full job: ' + (a.getAttribute('data-lb-title') || '');
        lbLink.hidden = false;
      } else {
        lbLink.hidden = true;
      }

      var many = lbGroup.length > 1;
      lbCount.textContent = many ? (lbIndex + 1) + ' / ' + lbGroup.length : '';
      lbPrev.hidden = !many;
      lbNext.hidden = !many;

      // Warm the neighbors so paging through feels instant.
      if (many) {
        [lbIndex - 1, lbIndex + 1].forEach(function (n) {
          var b = lbGroup[(n + lbGroup.length) % lbGroup.length];
          if (b !== a) { var pre = new Image(); pre.src = b.getAttribute('href'); }
        });
      }
    }

    var lbCleanedUp = true;

    function openLightbox(a) {
      if (!lb) buildLightbox();
      var group = a.getAttribute('data-lb');
      lbGroup = Array.prototype.filter.call(document.querySelectorAll('a.lb-item'), function (x) {
        return x.getAttribute('data-lb') === group;
      });
      lbOpener = a;
      lbCleanedUp = false;
      document.documentElement.style.overflow = 'hidden';
      lb.showModal();
      showPhoto(Math.max(0, lbGroup.indexOf(a)));
      lbClose.focus();
    }

    function closeLightbox() {
      if (lb && lb.open) lb.close();
      onLightboxClosed();
    }

    // Undo everything opening did: unlock page scrolling, drop the large
    // image, and put focus back on the photo that was clicked. Called directly
    // when we close the viewer, and from the dialog's close event for Escape,
    // which the browser closes natively. That event is dispatched
    // asynchronously, so relying on it alone left the page scroll-locked for a
    // moment or longer. The flag makes the second call a no-op.
    function onLightboxClosed() {
      if (lbCleanedUp) return;
      lbCleanedUp = true;
      document.documentElement.style.overflow = '';
      lbImg.removeAttribute('src');
      if (lbOpener) lbOpener.focus({ preventScroll: true });
    }

    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a.lb-item') : null;
      if (!a || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab still works
      e.preventDefault();
      openLightbox(a);
    });
  }

  // Lead tracking. Most customers call rather than book online, so a tap on
  // the phone number counts as a Google Ads conversion, and phone and email
  // taps are sent to Google Analytics along with where on the page they
  // happened. gtag() and CARCIS_TRACKING come from head-close.html; off the
  // production hostname nothing is sent.
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[href^="tel:"], a[href^="mailto:"]') : null;
    if (!a || typeof gtag !== 'function') return;
    var t = window.CARCIS_TRACKING || {};
    var area = a.closest('header') ? 'header'
      : a.closest('.nav-mobile') ? 'mobile_menu'
      : a.closest('footer') ? 'footer'
      : 'page';

    if (a.protocol === 'tel:') {
      if (t.adsCall) gtag('event', 'conversion', { send_to: t.adsCall, value: 1.0, currency: 'USD' });
      gtag('event', 'phone_click', { link_location: area });
    } else {
      gtag('event', 'email_click', { link_location: area });
    }
  });

})();

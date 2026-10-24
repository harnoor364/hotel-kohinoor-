/* Hotel Kohinoor Palace — page UI (header, menu, popups, forms, reveals) */
(function () {
  'use strict';

  var header = document.getElementById('siteHeader');
  var nav = document.getElementById('siteNav');
  var toggle = document.getElementById('navToggle');

  /* Header turns solid once the page scrolls */
  function onScroll() { header.classList.toggle('is-solid', window.scrollY > 40); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Mobile menu */
  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  toggle.addEventListener('click', function () { setMenu(!nav.classList.contains('is-open')); });
  nav.addEventListener('click', function (e) { if (e.target.closest('a, button')) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });

  /* In-page links: instant jump (a smooth scroll would race through the walkthrough) */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    var target = id === 'top' ? document.body : document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    var y = id === 'top' ? 0 : target.getBoundingClientRect().top + window.scrollY - (header.offsetHeight - 1);
    window.scrollTo({ top: y, behavior: 'instant' in document.documentElement.style ? 'instant' : 'auto' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  });

  /* ---------- Dialogs ---------- */
  function supportsDialog(d) { return typeof d.showModal === 'function'; }
  function openDialog(d) {
    if (supportsDialog(d)) { if (!d.open) d.showModal(); }
    else { d.setAttribute('open', ''); }
  }
  function closeDialog(d) { if (supportsDialog(d)) d.close(); else d.removeAttribute('open'); }

  var notice = document.getElementById('noticeDialog');
  var noticeTitle = document.getElementById('noticeTitle');
  var noticeLead = document.getElementById('noticeLead');
  var noticeBody = document.getElementById('noticeBody');
  var DEFAULT_BODY = 'This is a demo website. The hotel’s phone and WhatsApp details will appear here once confirmed.';

  function showNotice(title, lead, body) {
    noticeTitle.textContent = title || 'Contact us';
    noticeLead.textContent = lead || 'Contact number will be added soon.';
    noticeBody.textContent = body || DEFAULT_BODY;
    openDialog(notice);
  }
  window.KPNotice = showNotice;

  var booking = document.getElementById('bookingDialog');
  var bookingForm = document.getElementById('bookingForm');

  /* Close on backdrop click */
  [notice, booking].forEach(function (d) {
    d.addEventListener('click', function (e) { if (e.target === d) closeDialog(d); });
  });
  booking.querySelector('[data-close]').addEventListener('click', function () { closeDialog(booking); });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-open]');
    if (!btn) return;
    var kind = btn.getAttribute('data-open');
    if (kind === 'contact') {
      showNotice(btn.getAttribute('data-title') || 'Contact us');
    } else if (kind === 'booking') {
      var room = btn.getAttribute('data-room');
      if (room) bookingForm.elements.room.value = room;
      bookingForm.querySelector('.avail__error').textContent = '';
      openDialog(booking);
    }
  });

  /* ---------- Dates & availability forms ---------- */
  function iso(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function addDays(d, n) { var c = new Date(d); c.setDate(c.getDate() + n); return c; }
  function pretty(s) {
    var p = s.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  var today = new Date();
  function wireDates(inEl, outEl) {
    inEl.min = iso(today);
    inEl.value = iso(today);
    outEl.min = iso(addDays(today, 1));
    outEl.value = iso(addDays(today, 1));
    inEl.addEventListener('change', function () {
      if (!inEl.value) return;
      var p = inEl.value.split('-');
      var next = iso(addDays(new Date(+p[0], +p[1] - 1, +p[2]), 1));
      outEl.min = next;
      if (!outEl.value || outEl.value < next) outEl.value = next;
    });
  }

  function handleSearch(form, inEl, outEl, guestsEl, roomEl, onOk) {
    var err = form.querySelector('.avail__error');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.textContent = '';
      if (!inEl.value || !outEl.value) { err.textContent = 'Please choose check-in and check-out dates.'; return; }
      if (inEl.value < iso(today)) { err.textContent = 'Check-in can’t be in the past.'; return; }
      if (outEl.value <= inEl.value) { err.textContent = 'Check-out must be after check-in.'; return; }
      var guests = guestsEl.options[guestsEl.selectedIndex].text;
      var room = roomEl && roomEl.value !== 'Any room' ? roomEl.value + ', ' : '';
      if (onOk) onOk();
      showNotice(
        'Thanks for checking',
        'Online booking is coming soon.',
        'You searched ' + room + pretty(inEl.value) + ' to ' + pretty(outEl.value) + ' for ' + guests +
        '. Live availability isn’t connected in this demo. Contact number will be added soon.'
      );
    });
  }

  var availForm = document.getElementById('availForm');
  var aIn = document.getElementById('availIn');
  var aOut = document.getElementById('availOut');
  wireDates(aIn, aOut);
  handleSearch(availForm, aIn, aOut, document.getElementById('availGuests'));

  var bIn = bookingForm.elements.checkin;
  var bOut = bookingForm.elements.checkout;
  wireDates(bIn, bOut);
  handleSearch(bookingForm, bIn, bOut, bookingForm.elements.guests, bookingForm.elements.room, function () { closeDialog(booking); });

  /* ---------- Scroll reveal ---------- */
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach(function (el, i) {
      el.style.transitionDelay = (i % 4) * 70 + 'ms';
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }

  document.getElementById('year').textContent = new Date().getFullYear();
})();

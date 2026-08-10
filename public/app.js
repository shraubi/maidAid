const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} Ñ‡`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} â‚¬`;
const typeLabel = (type) => ({ independent: "Ð¡Ð°Ð¼Ð¾ÑÑ‚Ð¾ÑÑ‚ÐµÐ»ÑŒÐ½Ð°Ñ ÑƒÐ±Ð¾Ñ€ÐºÐ°", orientation: "ÐžÐ·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ", practice: "ÐŸÑ€Ð°ÐºÑ‚Ð¸ÐºÐ°", checkin: "Check in" })[type] ?? "Ð¢Ð¸Ð¿ Ð½Ðµ ÑƒÐºÐ°Ð·Ð°Ð½";
const kindLabel = (kind) => ({ apartment: "ÐšÐ²Ð°Ñ€Ñ‚Ð¸Ñ€Ð°", laundry: "Ð¡ÑƒÑˆÐºÐ°", partner_restaurant: "ÐŸÐ°Ñ€Ñ‚Ð½Ñ‘Ñ€" })[kind] ?? "ÐœÐµÑÑ‚Ð¾";
const mapsHref = (item) => item.mapsUrl || (item.latitude != null && item.longitude != null ? `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}` : item.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address)}` : null);

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401 && !url.startsWith("/api/auth/")) showAuth(); const error = new Error(body.error ?? "request_failed"); error.body = body; throw error; }
  return body;
}

let latestPreview = null;
let ledgerDays = new Map();
let editingDateIso = null;
let apartments = [];
let savedPlaces = [];
let mapItems = [];
let placesMap = null;
let pickerMap = null;
let markerLayer = null;
let productRelease = 1;
let activeRoute = "today";
let todayJobs = [];
let nextTodayJobId = 1;
let latestDayPayload = null;
let daySaved = false;
let selectedTodayDateIso = null;
let mapMode = (() => { try { return new URLSearchParams(location.search).get("view") || localStorage.getItem("maidaid:map-view") || "map"; } catch { return "map"; } })();
const today = new Date();
const calendarPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
let selectedPeriod = calendarPeriod;
let activeCleaner = null;

function showAuth(mode = "login") {
  activeCleaner = null;
  $("#auth-view").hidden = false;
  $(".app-header").hidden = true; $(".app-main").hidden = true; $(".mobile-nav").hidden = true;
  $$('[data-auth-mode]').forEach((button) => button.classList.toggle("active", button.dataset.authMode === mode));
  $("#login-form").hidden = mode !== "login"; $("#register-form").hidden = mode !== "register";
  $("#auth-error").hidden = true;
}

function showAuthenticated(cleaner) {
  activeCleaner = cleaner; $("#cleaner-name").textContent = cleaner.name;
  $("#auth-view").hidden = true; $(".app-header").hidden = false; $(".app-main").hidden = false; $(".mobile-nav").hidden = false;
}

function authErrorMessage(code) {
  return ({ invalid_credentials: "ÐÐµÐ²ÐµÑ€Ð½Ð¾Ðµ Ð¸Ð¼Ñ Ð¸Ð»Ð¸ PIN.", invalid_team_code: "ÐÐµÐ²ÐµÑ€Ð½Ñ‹Ð¹ ÐºÐ¾Ð´ ÐºÐ¾Ð¼Ð°Ð½Ð´Ñ‹.", cleaner_exists: "ÐŸÑ€Ð¾Ñ„Ð¸Ð»ÑŒ Ñ Ñ‚Ð°ÐºÐ¸Ð¼ Ð¸Ð¼ÐµÐ½ÐµÐ¼ ÑƒÐ¶Ðµ ÑÑƒÑ‰ÐµÑÑ‚Ð²ÑƒÐµÑ‚.", registration_disabled: "Ð ÐµÐ³Ð¸ÑÑ‚Ñ€Ð°Ñ†Ð¸Ñ Ð²Ñ€ÐµÐ¼ÐµÐ½Ð½Ð¾ Ð¾Ñ‚ÐºÐ»ÑŽÑ‡ÐµÐ½Ð°.", rate_limit_exceeded: "Ð¡Ð»Ð¸ÑˆÐºÐ¾Ð¼ Ð¼Ð½Ð¾Ð³Ð¾ Ð¿Ð¾Ð¿Ñ‹Ñ‚Ð¾Ðº. ÐŸÐ¾Ð¿Ñ€Ð¾Ð±ÑƒÐ¹Ñ‚Ðµ Ð¿Ð¾Ð·Ð¶Ðµ." })[code] || "ÐÐµ ÑƒÐ´Ð°Ð»Ð¾ÑÑŒ Ð¿Ñ€Ð¾Ð´Ð¾Ð»Ð¶Ð¸Ñ‚ÑŒ. ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ Ð´Ð°Ð½Ð½Ñ‹Ðµ Ð¸ Ð¿Ð¾Ð¿Ñ€Ð¾Ð±ÑƒÐ¹Ñ‚Ðµ ÐµÑ‰Ñ‘ Ñ€Ð°Ð·.";
}

$$('[data-auth-mode]').forEach((button) => button.addEventListener("click", () => showAuth(button.dataset.authMode)));
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#auth-error").hidden = true;
  try {
    const { cleaner } = await api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("#login-name").value, pin: $("#login-pin").value }) });
    showAuthenticated(cleaner); $("#login-pin").value = ""; await showRoute(routeFromPath());
  } catch (error) { $("#auth-error").textContent = authErrorMessage(error.message); $("#auth-error").hidden = false; }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#auth-error").hidden = true;
  if ($("#register-pin").value !== $("#register-pin-confirm").value) { $("#auth-error").textContent = "PIN-ÐºÐ¾Ð´Ñ‹ Ð½Ðµ ÑÐ¾Ð²Ð¿Ð°Ð´Ð°ÑŽÑ‚."; $("#auth-error").hidden = false; return; }
  try {
    const { cleaner } = await api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamCode: $("#register-team-code").value, name: $("#register-name").value, pin: $("#register-pin").value }) });
    showAuthenticated(cleaner); $("#register-form").reset(); await showRoute(routeFromPath());
  } catch (error) { $("#auth-error").textContent = authErrorMessage(error.message); $("#auth-error").hidden = false; }
});
$("#logout-button").addEventListener("click", async () => { try { await api("/api/auth/logout", { method: "POST" }); } finally { showAuth(); } });

function routeFromPath() {
  if (location.pathname.startsWith("/map")) return "map";
  if (location.pathname.startsWith("/ledger")) return "ledger";
  return "today";
}

async function showRoute(route, push = false) {
  activeRoute = route;
  $$(".app-view").forEach((view) => { view.hidden = view.id !== `view-${route}`; });
  $$('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (push) history.pushState({}, "", route === "today" ? "/today" : `/${route}`);
  if (route === "today") { await loadApartments(); renderTodayJobs(); }
  if (route === "map") await loadMapItems();
  if (route === "ledger") await loadLedger();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$('[data-route]').forEach((link) => link.addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); showRoute(link.dataset.route, true);
}));
window.addEventListener("popstate", async () => {
  await showRoute(routeFromPath());
  const direct = location.pathname.match(/^\/map\/apartments\/(\d+)$/);
  if (direct) await openApartmentDetail(Number(direct[1]), false);
  else if ($("#place-detail-dialog").open) $("#place-detail-dialog").close();
});

function setTodayState(state) {
  $("#today-editor").hidden = state !== "editor";
  $("#today-preview").hidden = state !== "preview";
}

const normalizeSearch = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const localDateIso = () => { const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; };
const displayTodayDate = (dateIso) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(`${dateIso}T12:00:00`));
selectedTodayDateIso = localDateIso();
$("#today-date-input").value = selectedTodayDateIso;

function updateTodayDateLabel() {
  $("#today-date-label").textContent = selectedTodayDateIso === localDateIso() ? "Ð¡ÐµÐ³Ð¾Ð´Ð½Ñ" : displayTodayDate(selectedTodayDateIso);
}
$("#today-date-input").addEventListener("change", (event) => {
  selectedTodayDateIso = event.target.value || localDateIso();
  event.target.value = selectedTodayDateIso;
  latestPreview = null; latestDayPayload = null; daySaved = false;
  updateTodayDateLabel();
});

function addTodayJob() {
  todayJobs.push({ id: nextTodayJobId++, apartmentId: null, newApartmentName: "", query: "", workType: "independent", durationMinutes: 180, dryer: "", otherExpense: "" });
  renderTodayJobs();
}

function apartmentMatches(query) {
  const needle = normalizeSearch(query);
  return apartments.map((apartment) => {
    const names = [apartment.canonicalName, ...(apartment.aliases ?? [])].map(normalizeSearch);
    const addressTokens = normalizeSearch(apartment.address).split(" ").filter(Boolean);
    const rank = names.some((name) => name.startsWith(needle)) ? 0 : addressTokens.some((part) => part.startsWith(needle)) ? 1 : 2;
    return { apartment, rank };
  }).filter(({ rank }) => !needle || rank < 2).sort((a, b) => a.rank - b.rank || a.apartment.canonicalName.localeCompare(b.apartment.canonicalName, "ru")).slice(0, 8).map(({ apartment }) => apartment);
}

function durationWheel(job) {
  const values = [-60, -30, 0, 30, 60].map((offset) => job.durationMinutes + offset).filter((value) => value >= 30 && value <= 300);
  return `<div class="duration-wheel" role="spinbutton" tabindex="0" aria-label="Ð”Ð»Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ð¾ÑÑ‚ÑŒ ÑƒÐ±Ð¾Ñ€ÐºÐ¸" aria-valuemin="30" aria-valuemax="300" aria-valuenow="${job.durationMinutes}" data-duration-wheel="${job.id}">${values.map((value) => `<button class="duration-option${value === job.durationMinutes ? " is-selected" : ""}" data-duration="${value}" type="button" aria-pressed="${value === job.durationMinutes}">${formatHours(value)}</button>`).join("")}</div>`;
}

function renderTodayJobs() {
  updateTodayDateLabel();
  $("#today-job-list").innerHTML = todayJobs.length ? todayJobs.map((job, index) => {
    const apartment = apartments.find((item) => item.id === job.apartmentId);
    const value = apartment?.canonicalName ?? job.newApartmentName ?? job.query;
    const selectedState = apartment ? `<small class="apartment-selection">${escapeHtml(apartment.address || "ÐÐ´Ñ€ÐµÑ Ð½ÑƒÐ¶Ð½Ð¾ Ð´Ð¾Ð±Ð°Ð²Ð¸Ñ‚ÑŒ")}</small>` : job.newApartmentName ? `<small class="apartment-selection needs-attention">ÐÐ¾Ð²Ð°Ñ ÐºÐ²Ð°Ñ€Ñ‚Ð¸Ñ€Ð° Â· Ð°Ð´Ñ€ÐµÑ Ð½ÑƒÐ¶Ð½Ð¾ Ð´Ð¾Ð±Ð°Ð²Ð¸Ñ‚ÑŒ</small>` : "";
    return `<article class="today-job-card" data-today-job="${job.id}">
      <div class="today-job-heading"><strong>ÐšÐ²Ð°Ñ€Ñ‚Ð¸Ñ€Ð° ${index + 1}</strong><button class="ghost remove-job" data-remove-job="${job.id}" type="button" aria-label="Ð£Ð´Ð°Ð»Ð¸Ñ‚ÑŒ ÐºÐ²Ð°Ñ€Ñ‚Ð¸Ñ€Ñƒ">Ð£Ð´Ð°Ð»Ð¸Ñ‚ÑŒ</button></div>
      <label class="apartment-search-label">ÐÐ°Ð·Ð²Ð°Ð½Ð¸Ðµ Ð¸Ð»Ð¸ ÑƒÐ»Ð¸Ñ†Ð°<div class="apartment-combobox"><input class="apartment-search" data-apartment-search="${job.id}" value="${escapeHtml(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="ÐÐ°Ð¿Ñ€Ð¸Ð¼ÐµÑ€, Bosquet Ð¸Ð»Ð¸ Lauriston" /><div class="apartment-results" data-apartment-results="${job.id}" role="listbox" hidden></div></div>${selectedState}</label>
      <label>Ð¢Ð¸Ð¿<select data-work-type="${job.id}"><option value="independent"${job.workType === "independent" ? " selected" : ""}>Ð£Ð±Ð¾Ñ€ÐºÐ°</option><option value="orientation"${job.workType === "orientation" ? " selected" : ""}>ÐžÐ·Ð½Ð°ÐºÐ¾Ð¼Ð»ÐµÐ½Ð¸Ðµ</option><option value="practice"${job.workType === "practice" ? " selected" : ""}>ÐŸÑ€Ð°ÐºÑ‚Ð¸ÐºÐ°</option><option value="checkin"${job.workType === "checkin" ? " selected" : ""}>Check-in</option></select></label>
      ${job.workType === "independent" ? `<div class="duration-field"><span>Ð¡ÐºÐ¾Ð»ÑŒÐºÐ¾ Ñ‡Ð°ÑÐ¾Ð²</span>${durationWheel(job)}</div>` : ""}
      ${job.workType === "independent" ? `<div class="job-expense-fields"><label>Ð¡ÑƒÑˆÐºÐ°, â‚¬<input data-job-expense="dryer" data-job-id="${job.id}" inputmode="decimal" value="${escapeHtml(job.dryer)}" placeholder="0" /></label><label>Ð”Ñ€ÑƒÐ³Ð¸Ðµ Ñ€Ð°ÑÑ…Ð¾Ð´Ñ‹, â‚¬<input data-job-expense="otherExpense" data-job-id="${job.id}" inputmode="decimal" value="${escapeHtml(job.otherExpense)}" placeholder="0" /></label></div>` : ""}
    </article>`;
  }).join("") : `<div class="today-empty"><strong>Ð”Ð¾Ð±Ð°Ð²ÑŒÑ‚Ðµ Ð¿ÐµÑ€Ð²ÑƒÑŽ ÐºÐ²Ð°Ñ€Ñ‚Ð¸Ñ€Ñƒ</strong><p>ÐšÐ°Ð¶Ð´Ð°Ñ Ñ€Ð°Ð±Ð¾Ñ‚Ð° Ð±ÑƒÐ´ÐµÑ‚ Ð¾Ñ‚Ð´ÐµÐ»ÑŒÐ½Ð¾Ð¹ ÐºÐ°Ñ€Ñ‚Ð¾Ñ‡ÐºÐ¾Ð¹.</p></div>`;
}

function showApartmentResults(input) {
  const job = todayJobs.find((item) => item.id === Number(input.dataset.apartmentSearch)); if (!job) return;
  const host = $(`[data-apartment-results="${job.id}"]`); const matches = apartmentMatches(input.value); const query = input.value.trim();
  const exact = query && apartments.some((apartment) => [apartment.canonicalName, ...(apartment.aliases ?? [])].some((value) => normalizeSearch(value) === normalizeSearch(query)));
  host.innerHTML = `${matches.map((apartment) => `<button data-choose-apartment="${apartment.id}" data-job-id="${job.id}" type="button" role="option"><strong>${escapeHtml(apartment.canonicalName)}</strong><small>${escapeHtml(apartment.address || "ÐÐ´Ñ€ÐµÑ Ð½ÑƒÐ¶Ð½Ð¾ Ð´Ð¾Ð±Ð°Ð²Ð¸Ñ‚ÑŒ")}</small></button>`).join("")}${query && !exact ? `<button class="create-apartment-option" data-create-apartment="${job.id}" type="button" role="option">+ Ð¡Ð¾Ð·Ð´Ð°Ñ‚ÑŒ Â«${escapeHtml(query)}Â»</button>` : ""}`;
  host.hidden = false; input.setAttribute("aria-expanded", "true");
}

$("#add-today-job").addEventListener("click", addTodayJob);
$("#today-job-list").addEventListener("focusin", (event) => { if (event.target.matches(".apartment-search")) showApartmentResults(event.target); });
$("#today-job-list").addEventListener("focusout", (event) => { if (event.target.matches(".apartment-search")) setTimeout(() => { const host = $(`[data-apartment-results="${event.target.dataset.apartmentSearch}"]`); if (host) host.hidden = true; event.target.setAttribute("aria-expanded", "false"); }, 120); });
$("#today-job-list").addEventListener("input", (event) => {
  const search = event.target.closest("[data-apartment-search]");
  if (search) { const job = todayJobs.find((item) => item.id === Number(search.dataset.apartmentSearch)); if (job) { job.query = search.value; job.apartmentId = null; job.newApartmentName = ""; showApartmentResults(search); } return; }
  const expense = event.target.closest("[data-job-expense]"); if (expense) { const job = todayJobs.find((item) => item.id === Number(expense.dataset.jobId)); if (job) job[expense.dataset.jobExpense] = expense.value; }
});
$("#today-job-list").addEventListener("change", (event) => { const select = event.target.closest("[data-work-type]"); if (select) { const job = todayJobs.find((item) => item.id === Number(select.dataset.workType)); if (job) { job.workType = select.value; if (job.workType !== "independent") { job.dryer = ""; job.otherExpense = ""; } renderTodayJobs(); } } });
$("#today-job-list").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove-job]"); if (remove) { todayJobs = todayJobs.filter((job) => job.id !== Number(remove.dataset.removeJob)); renderTodayJobs(); return; }
  const choice = event.target.closest("[data-choose-apartment]"); if (choice) { const job = todayJobs.find((item) => item.id === Number(choice.dataset.jobId)); const apartment = apartments.find((item) => item.id === Number(choice.dataset.chooseApartment)); if (job && aóM8¶‰žËkºwµçMÁ±…”µ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì½¹ÍÐ•ÉÉ½È€ô€ ˆÁ±…”µ™½É´µ•ÉÉ½Èˆ¤ì•ÉÉ½È¹¡¥‘‘•¸€ôÑÉÕ”ì(€½¹ÍÐ­¥¹€ô€ ˆÁ±…”µ­¥¹ˆ¤¹Ù…±Õ”ì½¹ÍÐ•‘¥Ñ-•ä€ô€ ˆÁ±…”µ•‘¥Ðµ¥ˆ¤¹Ù…±Õ”ì½¹ÍÐ±…Ñ¥ÑÕ‘”€ô€ ˆÁ±…”µ±…Ñ¥ÑÕ‘”ˆ¤¹Ù…±Õ”€ôôô€ˆˆ€üÕ¹‘•™¥¹•€è9Õµ‰•È  ˆÁ±…”µ±…Ñ¥ÑÕ‘”ˆ¤¹Ù…±Õ”¤ì½¹ÍÐ±½¹¥ÑÕ‘”€ô€ ˆÁ±…”µ±½¹¥ÑÕ‘”ˆ¤¹Ù…±Õ”€ôôô€ˆˆ€üÕ¹‘•™¥¹•€è9Õµ‰•È  ˆÁ±…”µ±½¹¥ÑÕ‘”ˆ¤¹Ù…±Õ”¤ì(€½¹ÍÐ½µµ½¸€ôì…‘‘É•ÍÌè€ ˆÁ±…”µ…‘‘É•ÍÌˆ¤¹Ù…±Õ”ñð¹Õ±°°µ…ÁÍUÉ°è€ ˆÁ±…”µµ…ÁÌµÕÉ°ˆ¤¹Ù…±Õ”ñð¹Õ±°°±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”°±½…Ñ¥½¹M½ÕÉ”è€ ˆÁ±…”µ±½…Ñ¥½¸µÍ½ÕÉ”ˆ¤¹Ù…±Õ”ñðÕ¹‘•™¥¹•°±½…Ñ¥½¹ÕÉ…å5•Ñ•ÉÌè€ ˆÁ±…”µ±½…Ñ¥½¸µ…ÕÉ…äˆ¤¹Ù…±Õ”€ôôô€ˆˆ€üÕ¹‘•™¥¹•€è9Õµ‰•È  ˆÁ±…”µ±½…Ñ¥½¸µ…ÕÉ…äˆ¤¹Ù…±Õ”¤ôì(€ÑÉäì(€€€¥˜€¡­¥¹€ôôô€‰…Á…ÉÑµ•¹Ðˆ¤ì(€€€€€½¹ÍÐÁ…å±½…€ôì…¹½¹¥…±9…µ”è€ ˆÁ±…”µ¹…µ”ˆ¤¹Ù…±Õ”°¹½Ñ•	½‘äè€ ˆÁ±…”µ¹½Ñ”ˆ¤¹Ù…±Õ”ñð¹Õ±°°€¸¸¹½µµ½¸ôì¥˜€ …•‘¥Ñ-•ä¤Á…å±½…¹…±¥…Í•Ì€ômtì(€€€€€½¹ÍÐ•¹‘Á½¥¹Ð€ô•‘¥Ñ-•ä€ü€½…Á¤½…Á…ÉÑµ•¹ÑÌ¼‘í•‘¥Ñ-•ä¹ÍÁ±¥Ð ˆèˆ¥lÅuõ€€è€ˆ½…Á¤½…Á…ÉÑµ•¹ÑÌˆì…Ý…¥Ð…Á¤¡•¹‘Á½¥¹Ð°ìµ•Ñ¡½è•‘¥Ñ-•ä€ü€‰AQ ˆ€è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡Á…å±½…¤ô¤ì(€€€ô•±Í”ì(€€€€€½¹ÍÐ…Á…ÉÑµ•¹Ñ%€ô€ ˆÁ±…”µ…Á…ÉÑµ•¹Ðµ±¥¹¬ˆ¤¹Ù…±Õ”€ü9Õµ‰•È  ˆÁ±…”µ…Á…ÉÑµ•¹Ðµ±¥¹¬ˆ¤¹Ù…±Õ”¤€èÕ¹‘•™¥¹•ì(€€€€€½¹ÍÐÁ…å±½…€ôì­¥¹°¹…µ”è€ ˆÁ±…”µ¹…µ”ˆ¤¹Ù…±Õ”°¹½Ñ”è€ ˆÁ±…”µ¹½Ñ”ˆ¤¹Ù…±Õ”ñð¹Õ±°°…Á…ÉÑµ•¹Ñ%°€¸¸¹½µµ½¸ôì(€€€€€½¹ÍÐ•¹‘Á½¥¹Ð€ô•‘¥Ñ-•ä€ü€½…Á¤½Á±…•Ì¼‘í•‘¥Ñ-•ä¹ÍÁ±¥Ð ˆèˆ¥lÅuõ€€è€ˆ½…Á¤½Á±…•Ìˆì¥˜€¡•‘¥Ñ-•ä¤‘•±•Ñ”Á…å±½…¹…Á…ÉÑµ•¹Ñ%ì½¹ÍÐÍ…Ù•€ô…Ý…¥Ð…Á¤¡•¹‘Á½¥¹Ð°ìµ•Ñ¡½è•‘¥Ñ-•ä€ü€‰AQ ˆ€è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡Á…å±½…¤ô¤ì(€€€€€¥˜€¡•‘¥Ñ-•ä€˜˜­¥¹€ôôô€‰±…Õ¹‘Éäˆ€˜˜…Á…ÉÑµ•¹Ñ%¤…Ý…¥Ð…Á¤¡€½…Á¤½…Á…ÉÑµ•¹ÑÌ¼‘í…Á…ÉÑµ•¹Ñ%‘ô½±…Õ¹‘Éäµ±¥¹­Í€°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ìÁ±…•%èÍ…Ù•¹Á±…”¹¥ô¤ô¤ì(€€€ô(€€€€ ˆÁ±…”µ™½É´µ‘¥…±½œˆ¤¹±½Í” ¤ìµ…Á%Ñ•µÌ€ômtì…Ý…¥Ð±½…‘5…Á%Ñ•µÌ¡ÑÉÕ”¤ì(€ô…Ñ €¡…Õ¡Ð¤ì•ÉÉ½È¹Ñ•áÑ½¹Ñ•¹Ð€ô…Õ¡Ð¹µ•ÍÍ…”€ôôô€‰…Á…ÉÑµ•¹Ñ}•á¥ÍÑÌˆ€ü€‹BkBËBÃFFBãFBÀƒFƒFBÃBëBãBðƒB÷BÃBßBËBÃB÷BãB×BðƒFBÛBÔƒFFF'B×FFBËFB×F¸ˆ€è€‹BwBÔƒFBÓBÃBïBûFF0ƒFBûFFBÃB÷BãFF0ƒBóB×FFBø¸ˆì•ÉÉ½È¹¡¥‘‘•¸€ô™…±Í”ìô)ô¤ì()…Íå¹Œ™Õ¹Ñ¥½¸½Á•¹1…Õ¹‘ÉåA¥­•È¡…Á…ÉÑµ•¹Ñ%¤ì(€½¹ÍÐÉ•ÍÕ±ÑÌ€ô€ ˆ±…Õ¹‘ÉäµÉ•ÍÕ±ÑÌˆ¤ì(€½¹ÍÐ±…Õ¹‘É¥•Ì€ôÍ…Ù•‘A±…•Ì¹™¥±Ñ•È ¡¥Ñ•´¤€ôø¥Ñ•´¹­¥¹€ôôô€‰±…Õ¹‘Éäˆ¤ì(€½¹ÍÐ…É‘Ì€ô±…Õ¹‘É¥•Ì¹µ…À ¡¥Ñ•´¤€ôøì(€€€½¹ÍÐ•¹•É¥Œ€ôl‹FFF#BëBÀˆ°€‹BÿFBÃFB×FB÷BÃF<‰t¹¥¹±Õ‘•Ì¡MÑÉ¥¹œ¡¥Ñ•´¹¹…µ”¤¹ÑÉ¥´ ¤¹Ñ½1½…±•1½Ý•É…Í” ‰ÉÔˆ¤¤ì(€€€½¹ÍÐÑ¥Ñ±”€ô•¹•É¥Œ€ü€¡¥Ñ•´¹…‘‘É•ÍÌñð€‹B‡FF#BëBÀƒBÇB×BÜƒBÃBÓFB×FBÀˆ¤€è¥Ñ•´¹¹…µ”ì(€€€½¹ÍÐÍÕ‰Ñ¥Ñ±”€ô•¹•É¥Œ€ü€ˆˆ€è¥Ñ•´¹…‘‘É•ÍÌì(€€€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰±…Õ¹‘Éäµ…ÉˆøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡Ñ¥Ñ±”¥ôð½ÍÑÉ½¹œø‘íÍÕ‰Ñ¥Ñ±”€ü€ñÀ±…ÍÌô‰µÕÑ•ˆø‘í•Í…Á•!Ñµ°¡ÍÕ‰Ñ¥Ñ±”¥ôð½Àù€€è€ˆ‰ôñ‰ÕÑÑ½¸±…ÍÌô‰ÁÉ¥µ…Éäˆ‘…Ñ„µ±¥¹¬µ±…Õ¹‘Éäôˆ‘í¥Ñ•´¹¥‘ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆûB‡BËF?BßBÃFF0ƒFƒBëBËBÃFFBãFBûBäð½‰ÕÑÑ½¸øð½…ÉÑ¥±”ù€ì(€ô¤¹©½¥¸ ˆˆ¤ì(€É•ÍÕ±ÑÌ¹‘…Ñ…Í•Ð¹…Á…ÉÑµ•¹Ñ%€ô…Á…ÉÑµ•¹Ñ%ì(€É•ÍÕ±ÑÌ¹¥¹¹•É!Q50€ô€ñÀ±…ÍÌô‰µÕÑ•ˆûBKF/BÇB×FBãFBÔƒFBûFFBÃB÷FGB÷B÷FF8ƒFFF#BëF¸ð½Àøñ‘¥Ø±…ÍÌô‰±…Õ¹‘Éäµ±¥ÍÐˆø‘í…É‘Ìñð€ˆñÀûB‡B÷BÃFBÃBïBÀƒBÓBûBÇBÃBËF3FBÔƒFFF#BëFƒFB×FB×BÜƒBëB÷BûBÿBëF€¬ƒB÷BÀƒBëBÃFFBÔ¸ð½Àø‰ôð½‘¥Øø‘íÁÉ½‘ÕÑI•±•…Í”€øô€Ì€ü€ñ‘¥Ø±…ÍÌô‰‘•Ñ…¥°µ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸±…ÍÌô‰Í•½¹‘…Éäˆ‘…Ñ„µ™¥¹µ¹•…É‰äôˆ‘í…Á…ÉÑµ•¹Ñ%‘ôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆûBwBÃBçFBàƒB÷BûBËF/BÔƒFF?BÓBûBðð½‰ÕÑÑ½¸øð½‘¥Øù€€è€ˆ‰õ€ì(€€ ˆ±…Õ¹‘Éäµ‘¥…±½œˆ¤¹Í¡½Ý5½‘…° ¤ì)ô()…Íå¹Œ™Õ¹Ñ¥½¸™¥¹‘9•…É‰å1…Õ¹‘Éä¡…Á…ÉÑµ•¹Ñ%¤ì(€½¹ÍÐÉ•ÍÕ±ÑÌ€ô€ ˆ±…Õ¹‘ÉäµÉ•ÍÕ±ÑÌˆ¤ìÉ•ÍÕ±ÑÌ¹¥¹¹•É!Q50€ô€ˆñÀ±…ÍÌõp‰µÕÑ•‘pˆûBcF'FƒBÇBïBãBÛBÃBçF#BãBÔƒBËBÃFBãBÃB÷FF/Š˜ð½Àøˆì€ ˆ±…Õ¹‘Éäµ‘¥…±½œˆ¤¹Í¡½Ý5½‘…° ¤ì(€ÑÉäì(€€€½¹ÍÐ‘…Ñ„€ô…Ý…¥Ð…Á¤¡€½…Á¤½…Á…ÉÑµ•¹ÑÌ¼‘í…Á…ÉÑµ•¹Ñ%‘ô½¹•…É‰äµ±…Õ¹‘É¥•Í€¤ì(€€€É•ÍÕ±ÑÌ¹¥¹¹•É!Q50€ô€‘í‘…Ñ„¹ÁÉ•™•ÉÉ•‘1…Õ¹‘Éä€ü€ñ‘¥Ø±…ÍÌô‰¹½Ñ¥”ÍÕ•ÍÌˆøñÍÑÉ½¹œûB‡B×BçFBÃFƒBËF/BÇFBÃB÷BÀèð½ÍÑÉ½¹œø€‘í•Í…Á•!Ñµ°¡‘…Ñ„¹ÁÉ•™•ÉÉ•‘1…Õ¹‘Éä¹¹…µ”¥ôð½‘¥Øù€€è€ˆ‰ôñ‘¥Ø±…ÍÌô‰±…Õ¹‘Éäµ±¥ÍÐˆø‘í‘…Ñ„¹…¹‘¥‘…Ñ•Ì¹±•¹Ñ €ü‘…Ñ„¹…¹‘¥‘…Ñ•Ì¹µ…À ¡¥Ñ•´°¥¹‘•à¤€ôø€ñ…ÉÑ¥±”±…ÍÌô‰±…Õ¹‘Éäµ…ÉˆøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡¥Ñ•´¹¹…µ”¥ôð½ÍÑÉ½¹œøñÀ±…ÍÌô‰µÕÑ•ˆø‘í5…Ñ ¹É½Õ¹¡¥Ñ•´¹‘¥ÍÑ…¹•5•Ñ•ÉÌ¥ôƒBðƒ
Ü€‘í¥Ñ•´¹‘Éå•É½¹™¥Éµ•€ü€‹FFF#BãBïBëBÀƒBûFBóB×FB×B÷BÀƒBÈ=M4ˆ€è€‹B÷BÃBïBãFBãBÔƒFFF#BãBïBëBàƒFFBûBãFƒBÿFBûBËB×FBãFF0‰ôð½Àøñ‘¥Ø±…ÍÌô‰‘•Ñ…¥°µ…Ñ¥½¹Ìˆøñ„±…ÍÌô‰Í•½¹‘…Éä…Ñ¥½¸µ±¥¹¬ˆ¡É•˜ôˆ‘í•Í…Á•!Ñµ°¡¥Ñ•´¹µ…ÁÍUÉ°¥ôˆÑ…É•Ðô‰}‰±…¹¬ˆÉ•°ô‰¹½½Á•¹•È¹½É•™•ÉÉ•ÈˆûB{FBëFF/FF0ƒBëBÃFFF,ð½„øñ‰ÕÑÑ½¸±…ÍÌô‰ÁÉ¥µ…Éäˆ‘…Ñ„µÍ•±•Ðµ±…Õ¹‘Éäôˆ‘í¥¹‘•áôˆÑåÁ”ô‰‰ÕÑÑ½¸ˆûBKF/BÇFBÃFF0ð½‰ÕÑÑ½¸øð½‘¥Øøð½…ÉÑ¥±”ù€¤¹©½¥¸ ˆˆ¤€è€ˆñÀûBƒF?BÓBûBðƒB÷BãFB×BÏBøƒB÷BÔƒB÷BÃBçBÓB×B÷Bø¸ð½Àø‰ôð½‘¥Øù€ì(€€€É•ÍÕ±ÑÌ¹‘…Ñ…Í•Ð¹…Á…ÉÑµ•¹Ñ%€ô…Á…ÉÑµ•¹Ñ%ìÉ•ÍÕ±ÑÌ¹}…¹‘¥‘…Ñ•Ì€ô‘…Ñ„¹…¹‘¥‘…Ñ•Ìì(€ô…Ñ €¡•ÉÉ½È¤ìÉ•ÍÕ±ÑÌ¹¥¹¹•É!Q50€ô€ñÀ±…ÍÌô‰¹½Ñ¥”•ÉÉ½Èˆø‘í•ÉÉ½È¹µ•ÍÍ…”€ôôô€‰…Á…ÉÑµ•¹Ñ}±½…Ñ¥½¹}É•ÅÕ¥É•ˆ€ü€‹B‡B÷BÃFBÃBïBÀƒFBëBÃBÛBãFBÔƒBÃBÓFB×FƒBãBïBàƒBëBûBûFBÓBãB÷BÃFF,ƒBëBËBÃFFBãFF,¸ˆ€è€‹BBûBãFBèƒFFF#B×BèƒBËFB×BóB×B÷B÷BøƒB÷B×BÓBûFFFBÿB×Bô¸‰ôð½Àù€ìô)ô( ˆ±…Õ¹‘ÉäµÉ•ÍÕ±ÑÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€½¹ÍÐ¹•…É‰ä€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ™¥¹µ¹•…É‰åtˆ¤ì¥˜€¡¹•…É‰ä¤ì…Ý…¥Ð™¥¹‘9•…É‰å1…Õ¹‘Éä¡9Õµ‰•È¡¹•…É‰ä¹‘…Ñ…Í•Ð¹™¥¹‘9•…É‰ä¤¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐ±¥¹­•€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ±¥¹¬µ±…Õ¹‘Éåtˆ¤ì(€½¹ÍÐ…Á…ÉÑµ•¹Ñ%€ô9Õµ‰•È  ˆ±…Õ¹‘ÉäµÉ•ÍÕ±ÑÌˆ¤¹‘…Ñ…Í•Ð¹…Á…ÉÑµ•¹Ñ%¤ì(€¥˜€¡±¥¹­•¤ì…Ý…¥Ð…Á¤¡€½…Á¤½…Á…ÉÑµ•¹ÑÌ¼‘í…Á…ÉÑµ•¹Ñ%‘ô½±…Õ¹‘Éäµ±¥¹­Í€°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ìÁ±…•%è9Õµ‰•È¡±¥¹­•¹‘…Ñ…Í•Ð¹±¥¹­1…Õ¹‘Éä¤ô¤ô¤ì€ ˆ±…Õ¹‘Éäµ‘¥…±½œˆ¤¹±½Í” ¤ìµ…Á%Ñ•µÌ€ômtì…Ý…¥Ð±½…‘5…Á%Ñ•µÌ¡ÑÉÕ”¤ì…Ý…¥Ð½Á•¹Á…ÉÑµ•¹Ñ•Ñ…¥°¡…Á…ÉÑµ•¹Ñ%°™…±Í”¤ìÉ•ÑÕÉ¸ìô(€½¹ÍÐ‰ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µÍ•±•Ðµ±…Õ¹‘Éåtˆ¤ì¥˜€ …‰ÕÑÑ½¸¤É•ÑÕÉ¸ì(€½¹ÍÐ…¹‘¥‘…Ñ”€ô€ ˆ±…Õ¹‘ÉäµÉ•ÍÕ±ÑÌˆ¤¹}…¹‘¥‘…Ñ•Ìü¹m9Õµ‰•È¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Í•±•Ñ1…Õ¹‘Éä¥tì¥˜€ ……¹‘¥‘…Ñ”¤É•ÑÕÉ¸ì(€…Ý…¥Ð…Á¤¡€½…Á¤½…Á…ÉÑµ•¹ÑÌ¼‘í…Á…ÉÑµ•¹Ñ%‘ô½±…Õ¹‘Éäµ±¥¹­Í€°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì…¹‘¥‘…Ñ”èì½ÍµQåÁ”è…¹‘¥‘…Ñ”¹½ÍµQåÁ”°½Íµ%è…¹‘¥‘…Ñ”¹½Íµ%°¹…µ”è…¹‘¥‘…Ñ”¹¹…µ”°…‘‘É•ÍÌè…¹‘¥‘…Ñ”¹…‘‘É•ÍÌ°±…Ñ¥ÑÕ‘”è…¹‘¥‘…Ñ”¹±…Ñ¥ÑÕ‘”°±½¹¥ÑÕ‘”è…¹‘¥‘…Ñ”¹±½¹¥ÑÕ‘”ôô¤ô¤ì(€€ ˆ±…Õ¹‘Éäµ‘¥…±½œˆ¤¹±½Í” ¤ìµ…Á%Ñ•µÌ€ômtì…Ý…¥Ð±½…‘5…Á%Ñ•µÌ¡ÑÉÕ”¤ì…Ý…¥Ð½Á•¹Á…ÉÑµ•¹Ñ•Ñ…¥°¡…Á…ÉÑµ•¹Ñ%°™…±Í”¤ì)ô¤ì()½¹ÍÐ™½Éµ…ÑA•É¥½€ô€¡Á•É¥½¤€ôøì½¹ÍÐmå•…È°µ½¹Ñ¡t€ôÁ•É¥½¹ÍÁ±¥Ð ˆ´ˆ¤¹µ…À¡9Õµ‰•È¤ì½¹ÍÐ±…‰•°€ô¹•Ü%¹Ñ°¹…Ñ•Q¥µ•½Éµ…Ð ‰ÉÔµITˆ°ìµ½¹Ñ è€‰±½¹œˆ°å•…Èè€‰¹Õµ•É¥Œˆô¤¹™½Éµ…Ð¡¹•Ü…Ñ”¡å•…È°µ½¹Ñ €´€Ä°€Ä¤¤ìÉ•ÑÕÉ¸±…‰•±lÁt¹Ñ½UÁÁ•É…Í” ¤€¬±…‰•°¹Í±¥” Ä¤ìôì)½¹ÍÐÁ•É¥½‘	½Õ¹‘Ì€ô€¡Á•É¥½¤€ôøì½¹ÍÐmå•…È°µ½¹Ñ¡t€ôÁ•É¥½¹ÍÁ±¥Ð ˆ´ˆ¤¹µ…À¡9Õµ‰•È¤ì½¹ÍÐ±…ÍÑ…ä€ô¹•Ü…Ñ”¡å•…È°µ½¹Ñ °€À¤¹•Ñ…Ñ” ¤ìÉ•ÑÕÉ¸ì™É½´è€‘íÁ•É¥½‘ô´ÀÅ€°Ñ¼è€‘íÁ•É¥½‘ô´‘íMÑÉ¥¹œ¡±…ÍÑ…ä¤¹Á…‘MÑ…ÉÐ È°€ˆÀˆ¥õ€ôìôì)™Õ¹Ñ¥½¸É•¹‘•É1•‘•È¡‘…Ñ„¤ì(€½¹ÍÐÑ½Ñ…±Ì€ô‘…Ñ„¹Ñ½Ñ…±Ìì±•‘•É…åÌ€ô¹•Ü5…À¡‘…Ñ„¹É½ÝÌ¹™¥±Ñ•È ¡É½Ü¤€ôøÉ½Ü¹É½ÝQåÁ”€ôôô€‰Ý½É¬ˆ¤¹µ…À ¡É½Ü¤€ôømÉ½Ü¹‘…Ñ•%Í¼°É½Ýt¤¤ì(€€ ˆ±•‘•ÈµÑ½Ñ…±Ìˆ¤¹¥¹¹•É!Q50€ôml‹BŸBÃFF,ˆ°™½Éµ…Ñ!½ÕÉÌ¡Ñ½Ñ…±Ì¹µ¥¹ÕÑ•Ì¥t°l‹BBûBïFFB×B÷Bøˆ°™½Éµ…Ñ5½¹•ä¡Ñ½Ñ…±Ì¹É••¥Ù•‘•¹ÑÌ¥t°l‹B{FFBÃFBûBèˆ°™½Éµ…Ñ5½¹•ä¡Ñ½Ñ…±Ì¹½ÕÑÍÑ…¹‘¥¹•¹ÑÌ¥t°l‹BƒBÃFFBûBÓF,ˆ°™½Éµ…Ñ5½¹•ä¡Ñ½Ñ…±Ì¹•áÁ•¹Í•Í•¹ÑÌ¥ut¹µ…À ¡m±…‰•°°Ù…±Õ•t¤€ôø€ñ‘¥Ø±…ÍÌô‰ÍÕµµ…Éäµ¥Ñ•´ˆøñÍÁ…¸ø‘í±…‰•±ôð½ÍÁ…¸øñÍÑÉ½¹œø‘íÙ…±Õ•ôð½ÍÑÉ½¹œøð½‘¥Øù€¤¹©½¥¸ ˆˆ¤ì(€€ ˆ±•‘•ÈµÉ½ÝÌˆ¤¹¥¹¹•É!Q50€ô‘…Ñ„¹É½ÝÌ¹±•¹Ñ €ü‘…Ñ„¹É½ÝÌ¹µ…À ¡É½Ü¤€ôøì(€€€¥˜€¡É½Ü¹É½ÝQåÁ”€ôôô€‰Ý½É¬ˆ¤ì(€€€€€½¹ÍÐ‘•Ñ…¥±Ì€ô€¡É½Ü¹Á…ÉÍ•‘•Ñ…¥±Ìü¹©½‰Ì€üümt¤¹µ…À ¡©½ˆ¤€ôø€ñ‘¥Ø±…ÍÌô‰±•‘•Èµ‘•Ñ…¥°µ¥Ñ•´ˆøñÍÑÉ½¹œø‘í•Í…Á•!Ñµ°¡©½ˆ¹½‰©•Ð¥ôð½ÍÑÉ½¹œøñÍµ…±°ø‘íÑåÁ•1…‰•°¡©½ˆ¹Ý½É­QåÁ”¥ôð½Íµ…±°øð½‘¥Øù€¤¹©½¥¸ ˆˆ¤ì(€€€€€É•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰±•‘•ÈµÉ½ÜˆøñÑ¥µ”ø‘í•Í…Á•!Ñµ°¡É½Ü¹‘…Ñ•%Í¼¥ôð½Ñ¥µ”øñ‘¥ØøñÍÑÉ½¹œø‘í™½Éµ…Ñ!½ÕÉÌ¡É½Ü¹µ¥¹ÕÑ•Ì¥ôƒFBÃBÇBûFF,ð½ÍÑÉ½¹œøñ‰ÈøñÍµ…±°ø‘í™½Éµ…Ñ5½¹•ä¡É½Ü¹¥¹½µ••¹ÑÌ¥ôƒBßBÃFBÃBÇBûFBÃB÷Bøƒ
Ü€‘í™½Éµ…Ñ5½¹•ä¡É½Ü¹•áÁ•¹Í•Í•¹ÑÌ¥ôƒFBÃFFBûBÓF,ð½Íµ…±°øð½‘¥Øøñ‘¥Ø±…ÍÌô‰±•‘•ÈµÉ½Üµ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸±…ÍÌô‰Í•½¹‘…Éäˆ‘…Ñ„µ•‘¥Ðµ‘…äôˆ‘íÉ½Ü¹‘…Ñ•%Í½ôˆûBcBßBóB×B÷BãFF0ð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸±…ÍÌô‰¡½ÍÐˆ‘…Ñ„µ‘•±•Ñ”µ‘…äôˆ‘íÉ½Ü¹‘…Ñ•%Í½ôˆûBBÓBÃBïBãFF0ð½‰ÕÑÑ½¸øð½‘¥Øøñ‘¥Ø±…ÍÌô‰±•‘•Èµ‘…äµÑ…‰Ìˆøñ‘•Ñ…¥±Ì±…ÍÌô‰±•‘•Èµ‘…äµ‘•Ñ…¥±ÌˆøñÍÕµµ…ÉäûBƒBÃFBÿBãFBÃB÷BãBÔð½ÍÕµµ…ÉäøñÁÉ”ø‘í•Í…Á•!Ñµ°¡É½Ü¹Í½ÕÉ•Q•áÐ¥ôð½ÁÉ”øð½‘•Ñ…¥±Ìøñ‘•Ñ…¥±Ì±…ÍÌô‰±•‘•Èµ‘…äµ‘•Ñ…¥±ÌˆøñÍÕµµ…ÉäûB{FFFGFð½ÍÕµµ…ÉäøñÁÉ”ø‘í•Í…Á•!Ñµ°¡É½Ü¹É•Á½ÉÑQ•áÐñð€‹B{FFFGFƒB÷BÔƒFBûFFBÃB÷FGBôˆ¥ôð½ÁÉ”øð½‘•Ñ…¥±Ìøñ‘•Ñ…¥±Ì±…ÍÌô‰±•‘•Èµ‘…äµ‘•Ñ…¥±ÌˆøñÍÕµµ…ÉäûBBûBÓFBûBÇB÷B×BÔð½ÍÕµµ…Éäøñ‘¥Ø±…ÍÌô‰±•‘•Èµ‘•Ñ…¥°µ±¥ÍÐˆø‘í‘•Ñ…¥±Ìñð€‹BƒBÃBÇBûFF,ƒB÷BÔƒB÷BÃBçBÓB×B÷F,‰ôð½‘¥Øøð½‘•Ñ…¥±Ìøð½‘¥Øøð½…ÉÑ¥±”ù€ì(€€€ô(€€€½¹ÍÐµ…¹Õ…°€ôÉ½Ü¹Í½ÕÉ”€ôôô€‰µ…¹Õ…°ˆìÉ•ÑÕÉ¸€ñ…ÉÑ¥±”±…ÍÌô‰±•‘•ÈµÉ½ÜˆøñÑ¥µ”ø‘íÉ½Ü¹‘…Ñ•%Í½ôð½Ñ¥µ”øñ‘¥ØøñÍÑÉ½¹œø‘í™½Éµ…Ñ5½¹•ä¡É½Ü¹…µ½Õ¹Ñ•¹ÑÌ¥ôƒBÿBûBïFFB×B÷Bøð½ÍÑÉ½¹œøñ‰ÈøñÍµ…±°ø‘í•Í…Á•!Ñµ°¡É½Ü¹¹½Ñ”ñð€¡µ…¹Õ…°€ü€‹BƒFFB÷BÃF<ƒBûBÿBïBÃFBÀˆ€è€‹BCBËBÃB÷FƒBãBÜƒBûFFFGFBÀˆ¤¥ôð½Íµ…±°øð½‘¥Øø‘íµ…¹Õ…°€ü€ñ‘¥Ø±…ÍÌô‰±•‘•ÈµÉ½Üµ…Ñ¥½¹Ìˆøñ‰ÕÑÑ½¸±…ÍÌô‰Í•½¹‘…Éäˆ‘…Ñ„µ•‘¥ÐµÁ…åµ•¹Ðôˆ‘íÉ½Ü¹¥‘ôˆ‘…Ñ„µ‘…Ñ”ôˆ‘íÉ½Ü¹‘…Ñ•%Í½ôˆ‘…Ñ„µ…µ½Õ¹Ðôˆ‘íÉ½Ü¹…µ½Õ¹Ñ•¹ÑÍôˆ‘…Ñ„µ¹½Ñ”ôˆ‘í•Í…Á•!Ñµ°¡É½Ü¹¹½Ñ”ñð€ˆˆ¥ôˆûBcBßBóB×B÷BãFF0ð½‰ÕÑÑ½¸øñ‰ÕÑÑ½¸±…ÍÌô‰¡½ÍÐˆ‘…Ñ„µ‘•±•Ñ”µÁ…åµ•¹Ðôˆ‘íÉ½Ü¹¥‘ôˆûBBÓBÃBïBãFF0ð½‰ÕÑÑ½¸øð½‘¥Øù€€è€ˆñÍÁ…¸±…ÍÌõp‰µÕÑ•‘pˆûBcBÜƒFB×BëFFBÀð½ÍÁ…¸ø‰ôð½…ÉÑ¥±”ù€ì(€ô¤¹©½¥¸ ˆˆ¤€è€ˆñÀ±…ÍÌõp‰µÕÑ•‘pˆûB_BÃBÿBãFB×BäƒBÿBûBëBÀƒB÷B×F¸ð½Àøˆì)ô)…Íå¹Œ™Õ¹Ñ¥½¸±½…‘1•‘•È ¤ìÑÉäì€ ˆ±•‘•Èµ•ÉÉ½Èˆ¤¹¡¥‘‘•¸€ôÑÉÕ”ì€ ˆ±•‘•ÈµÁ•É¥½µ±…‰•°ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô™½Éµ…ÑA•É¥½¡Í•±•Ñ•‘A•É¥½¤ì½¹ÍÐì™É½´°Ñ¼ô€ôÁ•É¥½‘	½Õ¹‘Ì¡Í•±•Ñ•‘A•É¥½¤ìÉ•¹‘•É1•‘•È¡…Ý…¥Ð…Á¤¡€½…Á¤½±•‘•Èý™É½´ô‘í™É½µô™Ñ¼ô‘íÑ½õ€¤¤ìô…Ñ ìÉ•¹‘•É1•‘•È¡ìÑ½Ñ…±Ìèìµ¥¹ÕÑ•Ìè€À°•…É¹•‘•¹ÑÌè€À°É••¥Ù•‘•¹ÑÌè€À°½ÕÑÍÑ…¹‘¥¹•¹ÑÌè€À°•áÁ•¹Í•Í•¹ÑÌè€À°¡•­¥¹•¹ÑÌè€Àô°É½ÝÌèmtô¤ì€ ˆ±•‘•Èµ•ÉÉ½Èˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹BwBÔƒFBÓBÃBïBûFF0ƒBßBÃBÏFFBßBãFF0ƒBãFFBûFBãF8¸ˆì€ ˆ±•‘•Èµ•ÉÉ½Èˆ¤¹¡¥‘‘•¸€ô™…±Í”ìôô( ˆ…‘µÁ…åµ•¹Ðµ‰ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø€ ˆÁ…åµ•¹Ðµ‘¥…±½œˆ¤¹Í¡½Ý5½‘…° ¤¤ì( ˆÁ…åµ•¹Ðµ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì…Ý…¥Ð…Á¤ ˆ½…Á¤½Á…åµ•¹ÑÌˆ°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì‘…Ñ•%Í¼è€ ˆÁ…åµ•¹Ðµ‘…Ñ”ˆ¤¹Ù…±Õ”°…µ½Õ¹Ñ•¹ÑÌè5…Ñ ¹É½Õ¹¡9Õµ‰•È  ˆÁ…åµ•¹Ðµ…µ½Õ¹Ðˆ¤¹Ù…±Õ”¤€¨€ÄÀÀ¤°¹½Ñ”è€ ˆÁ…åµ•¹Ðµ¹½Ñ”ˆ¤¹Ù…±Õ”ñðÕ¹‘•™¥¹•ô¤ô¤ì€ ˆÁ…åµ•¹Ðµ‘¥…±½œˆ¤¹±½Í” ¤ì€ ˆÁ…åµ•¹Ðµ…µ½Õ¹Ðˆ¤¹Ù…±Õ”€ô€ˆˆì€ ˆÁ…åµ•¹Ðµ¹½Ñ”ˆ¤¹Ù…±Õ”€ô€ˆˆì…Ý…¥Ð±½…‘1•‘•È ¤ìô¤ì( ˆÁ•É¥½‘Ìµ‰ÕÑÑ½¸ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€ ¤€ôøì½¹ÍÐìÁ•É¥½‘Ìô€ô…Ý…¥Ð…Á¤ ˆ½…Á¤½Á•É¥½‘Ìˆ¤ì½¹ÍÐ…Ù…¥±…‰±”€ôÁ•É¥½‘Ì¹µ…À ¡ìÁ•É¥½ô¤€ôøÁ•É¥½¤ì€ ˆÁ•É¥½‘Ìµ±¥ÍÐˆ¤¹¥¹¹•É!Q50€ô…Ù…¥±…‰±”¹µ…À ¡Á•É¥½¤€ôø€ñ‰ÕÑÑ½¸±…ÍÌôˆ‘íÁ•É¥½€ôôôÍ•±•Ñ•‘A•É¥½€ü€‰ÁÉ¥µ…Éäˆ€è€‰Í•½¹‘…Éä‰ôˆ‘…Ñ„µÁ•É¥½ôˆ‘íÁ•É¥½‘ôˆø‘í™½Éµ…ÑA•É¥½¡Á•É¥½¥ôð½‰ÕÑÑ½¸ù€¤¹©½¥¸ ˆˆ¤ì€ ˆÁ•É¥½‘Ìµ‘¥…±½œˆ¤¹Í¡½Ý5½‘…° ¤ìô¤ì( ˆÁ•É¥½‘Ìµ±¥ÍÐˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì½¹ÍÐ‰ÕÑÑ½¸€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µÁ•É¥½‘tˆ¤ì¥˜€ …‰ÕÑÑ½¸¤É•ÑÕÉ¸ìÍ•±•Ñ•‘A•É¥½€ô‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹Á•É¥½ì€ ˆÁ•É¥½‘Ìµ‘¥…±½œˆ¤¹±½Í” ¤ì…Ý…¥Ð±½…‘1•‘•È ¤ìô¤ì( ˆ±•‘•ÈµÉ½ÝÌˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì(€½¹ÍÐ•‘¥Ñ…ä€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ•‘¥Ðµ‘…åtˆ¤ì½¹ÍÐ‘•±•Ñ•…ä€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ‘•±•Ñ”µ‘…åtˆ¤ì½¹ÍÐ•‘¥ÑA…åµ•¹Ð€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ•‘¥ÐµÁ…åµ•¹Ñtˆ¤ì½¹ÍÐ‘•±•Ñ•A…åµ•¹Ð€ô•Ù•¹Ð¹Ñ…É•Ð¹±½Í•ÍÐ ‰m‘…Ñ„µ‘•±•Ñ”µÁ…åµ•¹Ñtˆ¤ì(€¥˜€¡•‘¥Ñ…ä¤ì½¹ÍÐ‘…ä€ô±•‘•É…åÌ¹•Ð¡•‘¥Ñ…ä¹‘…Ñ…Í•Ð¹•‘¥Ñ…ä¤ì¥˜€¡‘…ä¤ì•‘¥Ñ¥¹…Ñ•%Í¼€ô‘…ä¹‘…Ñ•%Í¼ì€ ˆ‘…äµ•‘¥Ðµ‘…Ñ”ˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô‘…ä¹‘…Ñ•%Í¼ì€ ˆ‘…äµ•‘¥ÐµÑ•áÐˆ¤¹Ù…±Õ”€ô‘…ä¹Í½ÕÉ•Q•áÐì€ ˆ‘…äµ•‘¥Ðµ‘¥…±½œˆ¤¹Í¡½Ý5½‘…° ¤ìôô(€¥˜€¡‘•±•Ñ•…ä€˜˜½¹™¥É´¡ƒBBÓBÃBïBãFF0ƒFBÃBÇBûFBãBäƒBÓB×B÷F0€‘í‘•±•Ñ•…ä¹‘…Ñ…Í•Ð¹‘•±•Ñ•…åôý€¤¤ì…Ý…¥Ð…Á¤¡€½…Á¤½‘…åÌ¼‘í‘•±•Ñ•…ä¹‘…Ñ…Í•Ð¹‘•±•Ñ•…åõ€°ìµ•Ñ¡½è€‰1Qˆô¤ì…Ý…¥Ð±½…‘1•‘•È ¤ìô(€¥˜€¡‘•±•Ñ•A…åµ•¹Ð€˜˜½¹™¥É´ ‹BBÓBÃBïBãFF0ƒF7FFƒBûBÿBïBÃFFüˆ¤¤ì…Ý…¥Ð…Á¤¡€½…Á¤½Á…åµ•¹ÑÌ¼‘í‘•±•Ñ•A…åµ•¹Ð¹‘…Ñ…Í•Ð¹‘•±•Ñ•A…åµ•¹Ñõ€°ìµ•Ñ¡½è€‰1Qˆô¤ì…Ý…¥Ð±½…‘1•‘•È ¤ìô(€¥˜€¡•‘¥ÑA…åµ•¹Ð¤ì½¹ÍÐ‘…Ñ•%Í¼€ôÁÉ½µÁÐ ‹BSBÃFBÀƒBûBÿBïBÃFF,èˆ°•‘¥ÑA…åµ•¹Ð¹‘…Ñ…Í•Ð¹‘…Ñ”¤ì¥˜€¡‘…Ñ•%Í¼€ôô¹Õ±°¤É•ÑÕÉ¸ì½¹ÍÐ…µ½Õ¹Ð€ôÁÉ½µÁÐ ‹B‡FBóBóBÀƒBÈƒB×BËFBøèˆ°MÑÉ¥¹œ¡9Õµ‰•È¡•‘¥ÑA…åµ•¹Ð¹‘…Ñ…Í•Ð¹…µ½Õ¹Ð¤€¼€ÄÀÀ¤¤ì¥˜€¡…µ½Õ¹Ð€ôô¹Õ±°¤É•ÑÕÉ¸ì½¹ÍÐ¹½Ñ”€ôÁÉ½µÁÐ ‹BFBãBóB×FBÃB÷BãBÔèˆ°•‘¥ÑA…åµ•¹Ð¹‘…Ñ…Í•Ð¹¹½Ñ”¤ì¥˜€¡¹½Ñ”€ôô¹Õ±°¤É•ÑÕÉ¸ì…Ý…¥Ð…Á¤¡€½…Á¤½Á…åµ•¹ÑÌ¼‘í•‘¥ÑA…åµ•¹Ð¹‘…Ñ…Í•Ð¹•‘¥ÑA…åµ•¹Ñõ€°ìµ•Ñ¡½è€‰AQ ˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ì‘…Ñ•%Í¼°…µ½Õ¹Ñ•¹ÑÌè5…Ñ ¹É½Õ¹¡9Õµ‰•È¡…µ½Õ¹Ð¹É•Á±…” ˆ°ˆ°€ˆ¸ˆ¤¤€¨€ÄÀÀ¤°¹½Ñ”ô¤ô¤ì…Ý…¥Ð±½…‘1•‘•È ¤ìô)ô¤ì( ˆ‘…äµ•‘¥Ðµ™½É´ˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰ÍÕ‰µ¥Ðˆ°…Íå¹Œ€¡•Ù•¹Ð¤€ôøì•Ù•¹Ð¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì½¹ÍÐÑ•áÐ€ô€ ˆ‘…äµ•‘¥ÐµÑ•áÐˆ¤¹Ù…±Õ”ì½¹ÍÐÁÉ•Ù¥•Ü€ô…Ý…¥Ð…Á¤ ˆ½…Á¤½ÁÉ•Ù¥•Üˆ°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ìÑ•áÐô¤ô¤ì¥˜€ …ÁÉ•Ù¥•Ü¹…¹M¡…É”ñðÁÉ•Ù¥•Ü¹Á…ÉÍ•¹‘…Ñ•%Í¼€„ôô•‘¥Ñ¥¹…Ñ•%Í¼¤ì€ ˆ‘…äµ•‘¥Ðµ•ÉÉ½Èˆ¤¹Ñ•áÑ½¹Ñ•¹Ð€ô€‹BFBûBËB×FF3FBÔƒFB×BëFFƒBàƒFBûFFBÃB÷BãFBÔƒBÿFB×BÛB÷F;F8ƒBÓBÃFF¸ˆì€ ˆ‘…äµ•‘¥Ðµ•ÉÉ½Èˆ¤¹¡¥‘‘•¸€ô™…±Í”ìÉ•ÑÕÉ¸ìô…Ý…¥Ð…Á¤ ˆ½…Á¤½‘…åÌˆ°ìµ•Ñ¡½è€‰A=MPˆ°¡•…‘•ÉÌèì€‰½¹Ñ•¹ÐµÑåÁ”ˆè€‰…ÁÁ±¥…Ñ¥½¸½©Í½¸ˆô°‰½‘äè)M=8¹ÍÑÉ¥¹¥™ä¡ìÑ•áÐô¤ô¤ì€ ˆ‘…äµ•‘¥Ðµ‘¥…±½œˆ¤¹±½Í” ¤ì…Ý…¥Ð±½…‘1•‘•È ¤ìô¤ì(( m‘…Ñ„µ±½Í”µ‘¥…±½tœ¤¹™½É…  ¡‰ÕÑÑ½¸¤€ôø‰ÕÑÑ½¸¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€ ¤€ôø‘½Õµ•¹Ð¹•Ñ±•µ•¹Ñ	å%¡‰ÕÑÑ½¸¹‘…Ñ…Í•Ð¹±½Í•¥…±½œ¤¹±½Í” ¤¤¤ì( ‘¥…±½œ¹…ÁÀµ‘¥…±½œœ¤¹™½É…  ¡‘¥…±½œ¤€ôø‘¥…±½œ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±¥¬ˆ°€¡•Ù•¹Ð¤€ôøì¥˜€¡•Ù•¹Ð¹Ñ…É•Ð€ôôô‘¥…±½œ¤‘¥…±½œ¹±½Í” ¤ìô¤¤ì( ˆÁ±…”µ‘•Ñ…¥°µ‘¥…±½œˆ¤¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ‰±½Í”ˆ°€ ¤€ôøì(€¥˜€¡±½…Ñ¥½¸¹Á…Ñ¡¹…µ”¹ÍÑ…ÉÑÍ]¥Ñ  ˆ½µ…À½…Á…ÉÑµ•¹ÑÌ¼ˆ¤¤¡¥ÍÑ½Éä¹É•Á±…•MÑ…Ñ”¡íô°€ˆˆ°€½µ…ÀýÙ¥•Üô‘íµ…Á5½‘•õ€¤ì)ô¤ì( ˆÁ…åµ•¹Ðµ‘…Ñ”ˆ¤¹Ù…±Õ”€ô¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹Í±¥” À°€ÄÀ¤ì()…Íå¹Œ™Õ¹Ñ¥½¸É•µ½Ù•1•…å=™™±¥¹” ¤ì(€ÑÉäì¥˜€ ‰Í•ÉÙ¥•]½É­•Èˆ¥¸¹…Ù¥…Ñ½È¤™½È€¡½¹ÍÐÉ•¥ÍÑÉ…Ñ¥½¸½˜…Ý…¥Ð¹…Ù¥…Ñ½È¹Í•ÉÙ¥•]½É­•È¹•ÑI•¥ÍÑÉ…Ñ¥½¹Ì ¤¤…Ý…¥ÐÉ•¥ÍÑÉ…Ñ¥½¸¹Õ¹É•¥ÍÑ•È ¤ìô…Ñ íô(€ÑÉäì¥˜€ ‰…¡•Ìˆ¥¸±½‰…±Q¡¥Ì¤™½È€¡½¹ÍÐ­•ä½˜…Ý…¥Ð…¡•Ì¹­•åÌ ¤¤¥˜€¡­•ä¹ÍÑ…ÉÑÍ]¥Ñ  ‰µ…¥‘…¥µÍ¡•±°´ˆ¤¤…Ý…¥Ð…¡•Ì¹‘•±•Ñ”¡­•ä¤ìô…Ñ íô)ô()…Íå¹Œ™Õ¹Ñ¥½¸¥¹¥Ñ¥…±¥é•ÁÀ ¤ì(€…Ý…¥ÐÉ•µ½Ù•1•…å=™™±¥¹” ¤ì(€ÑÉäìÁÉ½‘ÕÑI•±•…Í”€ô9Õµ‰•È ¡…Ý…¥Ð…Á¤ ˆ½…Á¤½…ÁÀµ½¹™¥œˆ¤¤¹ÁÉ½‘ÕÑI•±•…Í”¤ñð€Äìô…Ñ ìÁÉ½‘ÕÑI•±•…Í”€ô€Äìô(€€ ˆ…‘µÁ±…”µ‰ÕÑÑ½¸ˆ¤¹¡¥‘‘•¸€ôÁÉ½‘ÕÑI•±•…Í”€ð€Èì(€€ ˆÁ±…”µ™¥±Ñ•Èˆ¤¹¡¥‘‘•¸€ôÁÉ½‘ÕÑI•±•…Í”€ð€Èì(€ÑÉäì½¹ÍÐì±•…¹•Èô€ô…Ý…¥Ð…Á¤ ˆ½…Á¤½…ÕÑ ½µ”ˆ¤ìÍ¡½ÝÕÑ¡•¹Ñ¥…Ñ•¡±•…¹•È¤ìô…Ñ ìÍ¡½ÝÕÑ  ¤ìÉ•ÑÕÉ¸ìô(€…Ý…¥ÐÍ¡½ÝI½ÕÑ”¡É½ÕÑ•É½µA…Ñ  ¤¤ì(€½¹ÍÐ‘¥É•ÑÁ…ÉÑµ•¹Ð€ô±½…Ñ¥½¸¹Á…Ñ¡¹…µ”¹µ…Ñ  ½yp½µ…Áp½…Á…ÉÑµ•¹ÑÍp¼¡q¬¤¼¤ì(€¥˜€¡‘¥É•ÑÁ…ÉÑµ•¹Ð¤…Ý…¥Ð½Á•¹Á…ÉÑµ•¹Ñ•Ñ…¥°¡9Õµ‰•È¡‘¥É•ÑÁ…ÉÑµ•¹ÑlÅt¤°™…±Í”¤ì)ô()Ù½¥¥¹¥Ñ¥…±¥é•ÁÀ ¤ì
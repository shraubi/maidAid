const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} ч`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const typeLabel = (type) => ({ independent: "Самостоятельная уборка", orientation: "Ознакомление", practice: "Практика", checkin: "Check in" })[type] ?? "Тип не указан";
const kindLabel = (kind) => ({ apartment: "Квартира", laundry: "Сушка", partner_restaurant: "Партнёр" })[kind] ?? "Место";
const mapsHref = (item) => item ? item.mapsUrl || (item.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address)}` : item.latitude != null && item.longitude != null ? `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}` : null) : null;

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
let todayState = "editor";
let todayInitialized = false;
let savedTodayDay = null;
let savedTodayApartments = new Map();
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
  const cleanerChanged = activeCleaner?.id !== cleaner.id;
  activeCleaner = cleaner; $("#cleaner-name").textContent = cleaner.name;
  if (cleanerChanged) { todayInitialized = false; savedTodayDay = null; savedTodayApartments = new Map(); todayJobs = []; latestPreview = null; latestDayPayload = null; daySaved = false; setTodayState("editor"); }
  $("#auth-view").hidden = true; $(".app-header").hidden = false; $(".app-main").hidden = false; $(".mobile-nav").hidden = false;
}

function authErrorMessage(code) {
  return ({ invalid_credentials: "Неверное имя или PIN.", invalid_team_code: "Неверный код команды.", cleaner_exists: "Профиль с таким именем уже существует.", registration_disabled: "Регистрация временно отключена.", rate_limit_exceeded: "Слишком много попыток. Попробуйте позже." })[code] || "Не удалось продолжить. Проверьте данные и попробуйте ещё раз.";
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
  if ($("#register-pin").value !== $("#register-pin-confirm").value) { $("#auth-error").textContent = "PIN-коды не совпадают."; $("#auth-error").hidden = false; return; }
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
  document.body.classList.toggle("report-open", route === "today" && todayState === "preview");
  $$('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (push) history.pushState({}, "", route === "today" ? "/today" : `/${route}`);
  if (route === "today") {
    await loadApartments();
    if (!todayInitialized || todayState === "saved") await loadSavedToday(true);
    else if (todayState === "editor") renderTodayJobs();
  }
  if (route === "map") await loadMapItems();
  if (route === "ledger") await loadLedger();
  window.scrollTo({ top: 0, behavior: "auto" });
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
  todayState = state;
  $("#today-editor").hidden = state !== "editor";
  $("#today-preview").hidden = state !== "preview";
  $("#today-saved").hidden = state !== "saved";
  document.body.classList.toggle("report-open", state === "preview" && activeRoute === "today");
}

const normalizeSearch = (value) => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const localDateIso = () => { const value = new Date(); return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; };
const displayTodayDate = (dateIso) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(new Date(`${dateIso}T12:00:00`));
selectedTodayDateIso = localDateIso();
$("#today-date-input").value = selectedTodayDateIso;

function updateTodayDateLabel() {
  $("#today-date-label").textContent = selectedTodayDateIso === localDateIso() ? "Сегодня" : displayTodayDate(selectedTodayDateIso);
}
$("#today-date-input").addEventListener("change", (event) => {
  selectedTodayDateIso = event.target.value || localDateIso();
  event.target.value = selectedTodayDateIso;
  latestPreview = null; latestDayPayload = null; daySaved = false;
  updateTodayDateLabel();
});

function savedJobExpenses(day, job, jobIndex) {
  return (day.parsedDetails.expenses ?? []).filter((expense) => expense.jobIndex === jobIndex || (expense.jobIndex == null && expense.object === job.object));
}

async function hydrateSavedToday(day) {
  const ids = [...new Set((day.parsedDetails.jobs ?? []).map((job) => job.apartmentId).filter(Boolean))];
  const details = await Promise.all(ids.map(async (id) => {
    try { return [id, await api(`/api/apartments/${id}`)]; }
    catch { return [id, null]; }
  }));
  savedTodayApartments = new Map(details);
}

function renderSavedToday(statusText = "") {
  if (!savedTodayDay) return;
  const jobs = savedTodayDay.parsedDetails.jobs ?? [];
  $("#saved-today-summary").innerHTML = jobs.map((job, index) => {
    const detail = job.apartmentId ? savedTodayApartments.get(job.apartmentId) : null;
    const apartment = detail?.apartment ?? job;
    const apartmentRoute = mapsHref(apartment);
    const dryerRoute = mapsHref(detail?.preferredLaundry);
    const timing = job.startMinutes != null && job.endMinutes != null ? `${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)}` : formatHours(job.durationMinutes);
    const expenses = savedJobExpenses(savedTodayDay, job, index);
    return `<article class="saved-today-card">${job.apartmentId ? `<button class="saved-apartment-title" data-open-today-apartment="${job.apartmentId}" type="button">${escapeHtml(job.object)}</button>` : `<strong>${escapeHtml(job.object)}</strong>`}${apartment.address ? `<span class="saved-apartment-address">${escapeHtml(apartment.address)}</span>` : ""}<small>${escapeHtml(typeLabel(job.workType))} · ${escapeHtml(timing)}${expenses.length ? ` · ${escapeHtml(expenses.map((expense) => `${expense.category} ${formatMoney(expense.amountCents)}`).join(", "))}` : ""}</small><div class="saved-today-actions">${apartmentRoute ? `<a class="secondary action-link" href="${escapeHtml(apartmentRoute)}" target="_blank" rel="noopener noreferrer">Квартира</a>` : ""}${dryerRoute ? `<a class="primary action-link" href="${escapeHtml(dryerRoute)}" target="_blank" rel="noopener noreferrer">Сушка</a>` : ""}</div></article>`;
  }).join("");
  $("#saved-today-report").textContent = savedTodayDay.reportText || "Отчёт не сохранён";
  $("#saved-today-status").textContent = statusText;
  $("#saved-today-status").hidden = !statusText;
  setTodayState("saved");
}

async function loadSavedToday(force = false, statusText = "") {
  if (todayInitialized && !force) return;
  const dateIso = localDateIso();
  try {
    const data = await api(`/api/ledger?from=${dateIso}&to=${dateIso}`);
    savedTodayDay = data.rows.find((row) => row.rowType === "work" && row.dateIso === dateIso) ?? null;
    if (savedTodayDay) { await hydrateSavedToday(savedTodayDay); renderSavedToday(statusText); }
    else if (todayState === "saved" || !todayInitialized) setTodayState("editor");
  } catch {
    if (!todayInitialized) setTodayState("editor");
  }
  todayInitialized = true;
}

function centsInput(cents) { return cents ? String(cents / 100) : ""; }

function editSavedToday() {
  if (!savedTodayDay) return;
  selectedTodayDateIso = savedTodayDay.dateIso;
  $("#today-date-input").value = selectedTodayDateIso;
  todayJobs = (savedTodayDay.parsedDetails.jobs ?? []).map((job, index) => {
    const expenses = savedJobExpenses(savedTodayDay, job, index);
    const dryerCents = expenses.filter((expense) => normalizeSearch(expense.category).includes("сушк")).reduce((sum, expense) => sum + expense.amountCents, 0);
    const otherExpenseCents = expenses.filter((expense) => !normalizeSearch(expense.category).includes("сушк")).reduce((sum, expense) => sum + expense.amountCents, 0);
    const workType = ["independent", "orientation", "practice", "checkin"].includes(job.workType) ? job.workType : "independent";
    return { id: nextTodayJobId++, apartmentId: job.apartmentId, newApartmentName: job.apartmentId ? "" : job.object, query: job.object, workType, durationMinutes: Math.max(30, Math.min(300, Math.round((job.durationMinutes ?? 180) / 30) * 30)), dryer: centsInput(dryerCents), otherExpense: centsInput(otherExpenseCents) };
  });
  latestPreview = null; latestDayPayload = null; daySaved = false;
  updateTodayDateLabel(); renderTodayJobs(); setTodayState("editor");
}

$("#edit-saved-today").addEventListener("click", editSavedToday);
$("#saved-today-summary").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-today-apartment]");
  if (button) void openApartmentDetail(Number(button.dataset.openTodayApartment), false);
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
  return `<div class="duration-wheel" role="spinbutton" tabindex="0" aria-label="Длительность уборки" aria-valuemin="30" aria-valuemax="300" aria-valuenow="${job.durationMinutes}" data-duration-wheel="${job.id}">${values.map((value) => `<button class="duration-option${value === job.durationMinutes ? " is-selected" : ""}" data-duration="${value}" type="button" aria-pressed="${value === job.durationMinutes}">${formatHours(value)}</button>`).join("")}</div>`;
}

function renderTodayDraftSummary() {
  const draftMinutes = todayJobs.reduce((sum, job) => sum + (job.workType === "independent" ? job.durationMinutes : job.workType === "checkin" ? 30 : 60), 0);
  const draftExpenses = todayJobs.reduce((sum, job) => {
    if (job.workType !== "independent") return sum;
    const dryer = Number(String(job.dryer || 0).replace(",", "."));
    const other = Number(String(job.otherExpense || 0).replace(",", "."));
    return sum + (Number.isFinite(dryer) ? Math.round(dryer * 100) : 0) + (Number.isFinite(other) ? Math.round(other * 100) : 0);
  }, 0);
  $("#today-draft-summary").innerHTML = `<div><span>Часы</span><strong>${formatHours(draftMinutes)}</strong></div><div><span>Расход</span><strong>${formatMoney(draftExpenses)}</strong></div>`;
}

function renderTodayJobs() {
  updateTodayDateLabel();
  renderTodayDraftSummary();
  $("#today-job-list").innerHTML = todayJobs.length ? todayJobs.map((job, index) => {
    const apartment = apartments.find((item) => item.id === job.apartmentId);
    const value = apartment?.canonicalName ?? job.newApartmentName ?? job.query;
    const selectedState = apartment ? `<small class="apartment-selection">${escapeHtml(apartment.address || "Адрес нужно добавить")}</small>` : job.newApartmentName ? `<small class="apartment-selection needs-attention">Новая квартира · адрес нужно добавить</small>` : "";
    const draftExpenseCents = job.workType === "independent" ? [job.dryer, job.otherExpense].reduce((sum, amount) => { const value = Number(String(amount || 0).replace(",", ".")); return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0); }, 0) : 0;
    const summaryTiming = job.workType === "independent" ? formatHours(job.durationMinutes) : job.workType === "checkin" ? "0,5 ч" : "1 ч";
    const summaryType = ({ independent: "Уборка", orientation: "Ознакомление", practice: "Практика", checkin: "Check in" })[job.workType];
    return `<details class="today-job-card" data-today-job="${job.id}" open>
      <summary class="today-job-summary"><span><strong>${escapeHtml(value || `Квартира ${index + 1}`)}</strong><small>${escapeHtml(summaryType)}</small><em>${escapeHtml(summaryTiming)}${draftExpenseCents ? ` · ${escapeHtml(formatMoney(draftExpenseCents))} расходы` : ""}</em></span></summary>
      <div class="today-job-editor"><div class="today-job-heading"><strong>Квартира ${index + 1}</strong><button class="ghost remove-job" data-remove-job="${job.id}" type="button" aria-label="Удалить квартиру">Удалить</button></div>
      <label class="apartment-search-label">Название или улица<div class="apartment-combobox"><input class="apartment-search" data-apartment-search="${job.id}" value="${escapeHtml(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="Например, Bosquet или Lauriston" /><div class="apartment-results" data-apartment-results="${job.id}" role="listbox" hidden></div></div>${selectedState}</label>
      <label>Тип<select data-work-type="${job.id}"><option value="independent"${job.workType === "independent" ? " selected" : ""}>Уборка</option><option value="orientati…7291 tokens truncated…u0026& ["сушка", "прачечная"].includes(String(item.name).trim().toLocaleLowerCase("ru")); $("#place-name").value = item.canonicalName ?? (genericLaundry ? "" : item.name); $("#place-address").value = item.address ?? ""; $("#place-maps-url").value = item.mapsUrl ?? ""; $("#place-note").value = item.noteBody ?? item.note ?? ""; $("#place-latitude").value = item.latitude ?? ""; $("#place-longitude").value = item.longitude ?? ""; $("#place-location-source").value = item.locationSource ?? ""; updatePlaceKind(); $("#place-form-dialog").showModal();
  $("#place-kind").disabled = true;
}

$("#pick-location-button").addEventListener("click", () => {
  $("#coordinate-picker").hidden = false;
  if (!globalThis.L) { $("#place-location-status").textContent = "Карта выбора точки не загрузилась."; return; }
  setTimeout(() => {
    if (!pickerMap) { pickerMap = L.map("picker-map").setView([48.8566, 2.3522], 12); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(pickerMap); pickerMap.on("click", ({ latlng }) => { $("#place-latitude").value = latlng.lat; $("#place-longitude").value = latlng.lng; $("#place-location-source").value = "pin"; $("#place-location-status").textContent = "Точка выбрана вручную."; }); }
    pickerMap.invalidateSize(); const lat = Number($("#place-latitude").value); const lon = Number($("#place-longitude").value); if (Number.isFinite(lat) && Number.isFinite(lon)) pickerMap.setView([lat, lon], 16);
  }, 0);
});
$("#current-location-button").addEventListener("click", () => {
  if (!navigator.geolocation) { $("#place-location-status").textContent = "Геолокация недоступна."; return; }
  $("#place-location-status").textContent = "Определяю текущее место…";
  navigator.geolocation.getCurrentPosition(({ coords }) => { $("#place-latitude").value = coords.latitude; $("#place-longitude").value = coords.longitude; $("#place-location-source").value = "geolocation"; $("#place-location-accuracy").value = coords.accuracy; $("#place-location-status").textContent = `Текущее место сохранено, точность около ${Math.round(coords.accuracy)} м.`; }, () => { $("#place-location-status").textContent = "Не удалось получить геолокацию. Место можно сохранить без точки."; }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
});

$("#place-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const error = $("#place-form-error"); error.hidden = true;
  const kind = $("#place-kind").value; const editKey = $("#place-edit-id").value; const latitude = $("#place-latitude").value === "" ? undefined : Number($("#place-latitude").value); const longitude = $("#place-longitude").value === "" ? undefined : Number($("#place-longitude").value);
  const common = { address: $("#place-address").value || null, mapsUrl: $("#place-maps-url").value || null, latitude, longitude, locationSource: $("#place-location-source").value || undefined, locationAccuracyMeters: $("#place-location-accuracy").value === "" ? undefined : Number($("#place-location-accuracy").value) };
  try {
    if (kind === "apartment") {
      const payload = { canonicalName: $("#place-name").value, noteBody: $("#place-note").value || null, ...common }; if (!editKey) payload.aliases = [];
      const endpoint = editKey ? `/api/apartments/${editKey.split(":")[1]}` : "/api/apartments"; await api(endpoint, { method: editKey ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      const apartmentId = $("#place-apartment-link").value ? Number($("#place-apartment-link").value) : undefined;
      const payload = { kind, name: $("#place-name").value, note: $("#place-note").value || null, apartmentId, ...common };
      const endpoint = editKey ? `/api/places/${editKey.split(":")[1]}` : "/api/places"; if (editKey) delete payload.apartmentId; const saved = await api(endpoint, { method: editKey ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (editKey && kind === "laundry" && apartmentId) await api(`/api/apartments/${apartmentId}/laundry-links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ placeId: saved.place.id }) });
    }
    $("#place-form-dialog").close(); mapItems = []; await loadMapItems(true);
  } catch (caught) { error.textContent = caught.message === "apartment_exists" ? "Квартира с таким названием уже существует." : "Не удалось сохранить место."; error.hidden = false; }
});

async function openLaundryPicker(apartmentId) {
  const results = $("#laundry-results");
  const laundries = savedPlaces.filter((item) => item.kind === "laundry");
  const cards = laundries.map((item) => {
    const generic = ["сушка", "прачечная"].includes(String(item.name).trim().toLocaleLowerCase("ru"));
    const title = generic ? (item.address || "Сушка без адреса") : item.name;
    const subtitle = generic ? "" : item.address;
    return `<article class="laundry-card"><strong>${escapeHtml(title)}</strong>${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}<button class="primary" data-link-laundry="${item.id}" type="button">Связать с квартирой</button></article>`;
  }).join("");
  results.dataset.apartmentId = apartmentId;
  results.innerHTML = `<p class="muted">Выберите сохранённую сушку.</p><div class="laundry-list">${cards || "<p>Сначала добавьте сушку через кнопку + на карте.</p>"}</div>${productRelease >= 3 ? `<div class="detail-actions"><button class="secondary" data-find-nearby="${apartmentId}" type="button">Найти новые рядом</button></div>` : ""}`;
  $("#laundry-dialog").showModal();
}

async function findNearbyLaundry(apartmentId) {
  const results = $("#laundry-results"); results.innerHTML = "<p class=\"muted\">Ищу ближайшие варианты…</p>"; $("#laundry-dialog").showModal();
  try {
    const data = await api(`/api/apartments/${apartmentId}/nearby-laundries`);
    results.innerHTML = `${data.preferredLaundry ? `<div class="notice success"><strong>Сейчас выбрана:</strong> ${escapeHtml(data.preferredLaundry.name)}</div>` : ""}<div class="laundry-list">${data.candidates.length ? data.candidates.map((item, index) => `<article class="laundry-card"><strong>${escapeHtml(item.name)}</strong><p class="muted">${Math.round(item.distanceMeters)} м · ${item.dryerConfirmed ? "сушилка отмечена в OSM" : "наличие сушилки стоит проверить"}</p><div class="detail-actions"><a class="secondary action-link" href="${escapeHtml(item.mapsUrl)}" target="_blank" rel="noopener noreferrer">Открыть карты</a><button class="primary" data-select-laundry="${index}" type="button">Выбрать</button></div></article>`).join("") : "<p>Рядом ничего не найдено.</p>"}</div>`;
    results.dataset.apartmentId = apartmentId; results._candidates = data.candidates;
  } catch (error) { results.innerHTML = `<p class="notice error">${error.message === "apartment_location_required" ? "Сначала укажите адрес или координаты квартиры." : "Поиск сушек временно недоступен."}</p>`; }
}
$("#laundry-results").addEventListener("click", async (event) => {
  const nearby = event.target.closest("[data-find-nearby]"); if (nearby) { await findNearbyLaundry(Number(nearby.dataset.findNearby)); return; }
  const linked = event.target.closest("[data-link-laundry]");
  const apartmentId = Number($("#laundry-results").dataset.apartmentId);
  if (linked) { await api(`/api/apartments/${apartmentId}/laundry-links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ placeId: Number(linked.dataset.linkLaundry) }) }); $("#laundry-dialog").close(); mapItems = []; await loadMapItems(true); await openApartmentDetail(apartmentId, false); return; }
  const button = event.target.closest("[data-select-laundry]"); if (!button) return;
  const candidate = $("#laundry-results")._candidates?.[Number(button.dataset.selectLaundry)]; if (!candidate) return;
  await api(`/api/apartments/${apartmentId}/laundry-links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate: { osmType: candidate.osmType, osmId: candidate.osmId, name: candidate.name, address: candidate.address, latitude: candidate.latitude, longitude: candidate.longitude } }) });
  $("#laundry-dialog").close(); mapItems = []; await loadMapItems(true); await openApartmentDetail(apartmentId, false);
});

const formatPeriod = (period) => { const [year, month] = period.split("-").map(Number); const label = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1)); return label[0].toUpperCase() + label.slice(1); };
const periodBounds = (period) => { const [year, month] = period.split("-").map(Number); const lastDay = new Date(year, month, 0).getDate(); return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` }; };
function renderLedger(data) {
  const totals = data.totals; ledgerDays = new Map(data.rows.filter((row) => row.rowType === "work").map((row) => [row.dateIso, row]));
  $("#ledger-totals").innerHTML = [["Часы", formatHours(totals.minutes)], ["Получено", formatMoney(totals.receivedCents)], ["Остаток", formatMoney(totals.outstandingCents)], ["Расходы", formatMoney(totals.expensesCents)]].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#ledger-rows").innerHTML = data.rows.length ? data.rows.map((row) => {
    if (row.rowType === "work") {
      const details = (row.parsedDetails?.jobs ?? []).map((job) => `<div class="ledger-detail-item"><strong>${escapeHtml(job.object)}</strong><small>${typeLabel(job.workType)}</small></div>`).join("");
      return `<details class="ledger-row"><summary class="ledger-row-summary"><time>${escapeHtml(row.dateIso)}</time><span><strong>${formatHours(row.minutes)} работы</strong><small>${formatMoney(row.incomeCents)} заработано · ${formatMoney(row.expensesCents)} расходы</small></span><i aria-hidden="true"></i></summary><div class="ledger-row-panel"><div class="ledger-row-actions"><button class="secondary" data-edit-day="${row.dateIso}">Изменить</button><button class="ghost" data-delete-day="${row.dateIso}">Удалить</button></div><div class="ledger-day-tabs"><details class="ledger-day-details"><summary>Расписание</summary><pre>${escapeHtml(row.sourceText)}</pre></details><details class="ledger-day-details"><summary>Отчёт</summary><pre>${escapeHtml(row.reportText || "Отчёт не сохранён")}</pre></details><details class="ledger-day-details"><summary>Подробнее</summary><div class="ledger-detail-list">${details || "Работы не найдены"}</div></details></div></div></details>`;
    }
    const manual = row.source === "manual"; return `<details class="ledger-row"><summary class="ledger-row-summary"><time>${row.dateIso}</time><span><strong>${formatMoney(row.amountCents)} получено</strong><small>${escapeHtml(row.note || (manual ? "Ручная оплата" : "Аванс из отчёта"))}</small></span><i aria-hidden="true"></i></summary><div class="ledger-row-panel">${manual ? `<div class="ledger-row-actions"><button class="secondary" data-edit-payment="${row.id}" data-date="${row.dateIso}" data-amount="${row.amountCents}" data-note="${escapeHtml(row.note || "")}">Изменить</button><button class="ghost" data-delete-payment="${row.id}">Удалить</button></div>` : "<span class=\"muted\">Оплата создана из текста рабочего дня.</span>"}</div></details>`;
  }).join("") : "<p class=\"muted\">Записей пока нет.</p>";
}
async function loadLedger() { try { $("#ledger-error").hidden = true; $("#ledger-period-label").textContent = formatPeriod(selectedPeriod); const { from, to } = periodBounds(selectedPeriod); renderLedger(await api(`/api/ledger?from=${from}&to=${to}`)); } catch { renderLedger({ totals: { minutes: 0, earnedCents: 0, receivedCents: 0, outstandingCents: 0, expensesCents: 0, checkinCents: 0 }, rows: [] }); $("#ledger-error").textContent = "Не удалось загрузить историю."; $("#ledger-error").hidden = false; } }
$("#add-payment-button").addEventListener("click", () => $("#payment-dialog").showModal());
$("#payment-form").addEventListener("submit", async (event) => { event.preventDefault(); await api("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso: $("#payment-date").value, amountCents: Math.round(Number($("#payment-amount").value) * 100), note: $("#payment-note").value || undefined }) }); $("#payment-dialog").close(); $("#payment-amount").value = ""; $("#payment-note").value = ""; await loadLedger(); });
$("#periods-button").addEventListener("click", async () => { const { periods } = await api("/api/periods"); const available = periods.map(({ period }) => period); $("#periods-list").innerHTML = available.map((period) => `<button class="${period === selectedPeriod ? "primary" : "secondary"}" data-period="${period}">${formatPeriod(period)}</button>`).join(""); $("#periods-dialog").showModal(); });
$("#periods-list").addEventListener("click", async (event) => { const button = event.target.closest("[data-period]"); if (!button) return; selectedPeriod = button.dataset.period; $("#periods-dialog").close(); await loadLedger(); });
$("#ledger-rows").addEventListener("click", async (event) => {
  const editDay = event.target.closest("[data-edit-day]"); const deleteDay = event.target.closest("[data-delete-day]"); const editPayment = event.target.closest("[data-edit-payment]"); const deletePayment = event.target.closest("[data-delete-payment]");
  if (editDay) { const day = ledgerDays.get(editDay.dataset.editDay); if (day) { editingDateIso = day.dateIso; $("#day-edit-date").textContent = day.dateIso; $("#day-edit-text").value = day.sourceText; $("#day-edit-dialog").showModal(); } }
  if (deleteDay && confirm(`Удалить рабочий день ${deleteDay.dataset.deleteDay}?`)) { await api(`/api/days/${deleteDay.dataset.deleteDay}`, { method: "DELETE" }); await loadLedger(); }
  if (deletePayment && confirm("Удалить эту оплату?")) { await api(`/api/payments/${deletePayment.dataset.deletePayment}`, { method: "DELETE" }); await loadLedger(); }
  if (editPayment) { const dateIso = prompt("Дата оплаты:", editPayment.dataset.date); if (dateIso == null) return; const amount = prompt("Сумма в евро:", String(Number(editPayment.dataset.amount) / 100)); if (amount == null) return; const note = prompt("Примечание:", editPayment.dataset.note); if (note == null) return; await api(`/api/payments/${editPayment.dataset.editPayment}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso, amountCents: Math.round(Number(amount.replace(",", ".")) * 100), note }) }); await loadLedger(); }
});
$("#day-edit-form").addEventListener("submit", async (event) => { event.preventDefault(); const text = $("#day-edit-text").value; const preview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); if (!preview.canShare || preview.parsed.dateIso !== editingDateIso) { $("#day-edit-error").textContent = "Проверьте текст и сохраните прежнюю дату."; $("#day-edit-error").hidden = false; return; } await api("/api/days", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); $("#day-edit-dialog").close(); await loadLedger(); });

$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close()));
$$('dialog.app-dialog').forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); }));
$("#place-detail-dialog").addEventListener("close", () => {
  if (location.pathname.startsWith("/map/apartments/")) history.replaceState({}, "", `/map?view=${mapMode}`);
});
$("#payment-date").value = new Date().toISOString().slice(0, 10);

async function removeLegacyOffline() {
  try { if ("serviceWorker" in navigator) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); } catch {}
  try { if ("caches" in globalThis) for (const key of await caches.keys()) if (key.startsWith("maidaid-shell-")) await caches.delete(key); } catch {}
}

async function initializeApp() {
  await removeLegacyOffline();
  try { productRelease = Number((await api("/api/app-config")).productRelease) || 1; } catch { productRelease = 1; }
  $("#add-place-button").hidden = productRelease < 2;
  $("#place-filter").hidden = productRelease < 2;
  try { const { cleaner } = await api("/api/auth/me"); showAuthenticated(cleaner); } catch { showAuth(); return; }
  await showRoute(routeFromPath());
  const directApartment = location.pathname.match(/^\/map\/apartments\/(\d+)$/);
  if (directApartment) await openApartmentDetail(Number(directApartment[1]), false);
}

void initializeApp();

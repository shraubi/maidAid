const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} ч`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const typeLabel = (type) => ({ independent: "Самостоятельная уборка", orientation: "Ознакомление", practice: "Практика", checkin: "Check in" })[type] ?? "Тип не указан";
const kindLabel = (kind) => ({ apartment: "Квартира", laundry: "Сушка", partner_restaurant: "Партнёр" })[kind] ?? "Место";
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
  $("#today-date-label").textContent = selectedTodayDateIso === localDateIso() ? "Сегодня" : displayTodayDate(selectedTodayDateIso);
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
  return `<div class="duration-wheel" role="spinbutton" tabindex="0" aria-label="Длительность уборки" aria-valuemin="30" aria-valuemax="300" aria-valuenow="${job.durationMinutes}" data-duration-wheel="${job.id}">${values.map((value) => `<button class="duration-option${value === job.durationMinutes ? " is-selected" : ""}" data-duration="${value}" type="button" aria-pressed="${value === job.durationMinutes}">${formatHours(value)}</button>`).join("")}</div>`;
}

function renderTodayJobs() {
  updateTodayDateLabel();
  $("#today-job-list").innerHTML = todayJobs.length ? todayJobs.map((job, index) => {
    const apartment = apartments.find((item) => item.id === job.apartmentId);
    const value = apartment?.canonicalName ?? job.newApartmentName ?? job.query;
    const selectedState = apartment ? `<small class="apartment-selection">${escapeHtml(apartment.address || "Адрес нужно добавить")}</small>` : job.newApartmentName ? `<small class="apartment-selection needs-attention">Новая квартира · адрес нужно добавить</small>` : "";
    return `<article class="today-job-card" data-today-job="${job.id}">
      <div class="today-job-heading"><strong>Квартира ${index + 1}</strong><button class="ghost remove-job" data-remove-job="${job.id}" type="button" aria-label="Удалить квартиру">Удалить</button></div>
      <label class="apartment-search-label">Название или улица<div class="apartment-combobox"><input class="apartment-search" data-apartment-search="${job.id}" value="${escapeHtml(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="Например, Bosquet или Lauriston" /><div class="apartment-results" data-apartment-results="${job.id}" role="listbox" hidden></div></div>${selectedState}</label>
      <label>Тип<select data-work-type="${job.id}"><option value="independent"${job.workType === "independent" ? " selected" : ""}>Уборка</option><option value="orientation"${job.workType === "orientation" ? " selected" : ""}>Ознакомление</option><option value="practice"${job.workType === "practice" ? " selected" : ""}>Практика</option><option value="checkin"${job.workType === "checkin" ? " selected" : ""}>Check-in</option></select></label>
      ${job.workType === "independent" ? `<div class="duration-field"><span>Сколько часов</span>${durationWheel(job)}</div>` : ""}
      ${job.workType === "independent" ? `<div class="job-expense-fields"><label>Сушка, €<input data-job-expense="dryer" data-job-id="${job.id}" inputmode="decimal" value="${escapeHtml(job.dryer)}" placeholder="0" /></label><label>Другие расходы, €<input data-job-expense="otherExpense" data-job-id="${job.id}" inputmode="decimal" value="${escapeHtml(job.otherExpense)}" placeholder="0" /></label></div>` : ""}
    </article>`;
  }).join("") : `<div class="today-empty"><strong>Добавьте первую квартиру</strong><p>Каждая работа будет отдельной карточкой.</p></div>`;
}

function showApartmentResults(input) {
  const job = todayJobs.find((item) => item.id === Number(input.dataset.apartmentSearch)); if (!job) return;
  const host = $(`[data-apartment-results="${job.id}"]`); const matches = apartmentMatches(input.value); const query = input.value.trim();
  const exact = query && apartments.some((apartment) => [apartment.canonicalName, ...(apartment.aliases ?? [])].some((value) => normalizeSearch(value) === normalizeSearch(query)));
  host.innerHTML = `${matches.map((apartment) => `<button data-choose-apartment="${apartment.id}" data-job-id="${job.id}" type="button" role="option"><strong>${escapeHtml(apartment.canonicalName)}</strong><small>${escapeHtml(apartment.address || "Адрес нужно добавить")}</small></button>`).join("")}${query && !exact ? `<button class="create-apartment-option" data-create-apartment="${job.id}" type="button" role="option">+ Создать «${escapeHtml(query)}»</button>` : ""}`;
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
  const choice = event.target.closest("[data-choose-apartment]"); if (choice) { const job = todayJobs.find((item) => item.id === Number(choice.dataset.jobId)); const apartment = apartments.find((item) => item.id === Number(choice.dataset.chooseApartment)); if (job && apartment) { job.apartmentId = apartment.id; job.newApartmentName = ""; job.query = apartment.canonicalName; renderTodayJobs(); } return; }
  const create = event.target.closest("[data-create-apartment]"); if (create) { const job = todayJobs.find((item) => item.id === Number(create.dataset.createApartment)); if (job && job.query.trim()) { job.apartmentId = null; job.newApartmentName = job.query.trim(); renderTodayJobs(); } return; }
  const duration = event.target.closest("[data-duration]"); if (duration) { const card = duration.closest("[data-today-job]"); const job = todayJobs.find((item) => item.id === Number(card.dataset.todayJob)); if (job) { job.durationMinutes = Number(duration.dataset.duration); renderTodayJobs(); } }
});
$("#today-job-list").addEventListener("keydown", (event) => {
  const search = event.target.closest("[data-apartment-search]");
  if (search && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const options = [...$(`[data-apartment-results="${search.dataset.apartmentSearch}"]`).querySelectorAll("button")]; (event.key === "ArrowDown" ? options[0] : options.at(-1))?.focus(); return; }
  const wheel = event.target.closest("[data-duration-wheel]"); if (!wheel || !["ArrowLeft", "ArrowRight"].includes(event.key)) return; event.preventDefault(); const job = todayJobs.find((item) => item.id === Number(wheel.dataset.durationWheel)); if (job) { job.durationMinutes = Math.max(30, Math.min(300, job.durationMinutes + (event.key === "ArrowRight" ? 30 : -30))); renderTodayJobs(); $(`[data-duration-wheel="${job.id}"]`)?.focus(); }
});
$("#today-job-list").addEventListener("wheel", (event) => { const wheel = event.target.closest("[data-duration-wheel]"); if (!wheel) return; event.preventDefault(); const job = todayJobs.find((item) => item.id === Number(wheel.dataset.durationWheel)); if (job) { job.durationMinutes = Math.max(30, Math.min(300, job.durationMinutes + (event.deltaY > 0 || event.deltaX > 0 ? 30 : -30))); renderTodayJobs(); } }, { passive: false });

function moneyCents(value, label) { if (!String(value).trim()) return 0; const amount = Number(String(value).replace(",", ".")); if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label}: укажите корректную сумму`); return Math.round(amount * 100); }
function buildTodayPayload() {
  if (!todayJobs.length) throw new Error("Добавьте хотя бы одну квартиру");
  return { format: "structured", dateIso: selectedTodayDateIso, jobs: todayJobs.map((job, index) => {
    if (!job.apartmentId && !job.newApartmentName) throw new Error(`Квартира ${index + 1}: выберите вариант из поиска или создайте новую`);
    return { ...(job.apartmentId ? { apartmentId: job.apartmentId } : { newApartmentName: job.newApartmentName }), workType: job.workType, ...(job.workType === "independent" ? { durationMinutes: job.durationMinutes, dryerCents: moneyCents(job.dryer, "Сушка"), otherExpenseCents: moneyCents(job.otherExpense, "Другие расходы") } : { dryerCents: 0, otherExpenseCents: 0 }) };
  }) };
}

function renderPreview(data) {
  const problems = [...data.issues.map((issue) => issue.message), ...data.unparsedLines.map((line) => `Не распознано: ${line}`)];
  $("#issue-list").hidden = !problems.length;
  $("#issue-list").innerHTML = problems.length ? `<strong>Нужно исправить</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>` : "";
  const jobs = data.parsed.jobs.map((job, jobIndex) => {
    const expenses = data.parsed.expenses.filter((expense) => expense.jobIndex === jobIndex || (expense.jobIndex == null && expense.object === job.object));
    const timing = job.startMinutes != null && job.endMinutes != null ? `${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)}` : formatHours(job.durationMinutes);
    return `<article class="job"><strong>${escapeHtml(job.object)}</strong><span>${timing}</span><small>${typeLabel(job.workType)}${job.companion ? ` · ${escapeHtml(job.companion)}` : ""}</small>${expenses.length ? `<small class="job-expenses">Расходы: ${expenses.map((expense) => `${escapeHtml(expense.category)} ${formatMoney(expense.amountCents)}`).join(", ")}</small>` : ""}</article>`;
  }).join("");
  const unmatched = data.parsed.expenses.filter((expense) => expense.jobIndex == null && (!expense.object || !data.parsed.jobs.some((job) => job.object === expense.object)));
  const expenses = unmatched.map((expense) => `<article class="expense"><strong>${escapeHtml(expense.category)}${expense.object ? ` · ${escapeHtml(expense.object)}` : ""}</strong><span>${formatMoney(expense.amountCents)}</span></article>`).join("");
  $("#parsed-summary").innerHTML = `<p class="muted">${escapeHtml(data.parsed.displayDate ?? "Дата не определена")}</p><div class="job-list">${jobs || "<p>Работы не найдены.</p>"}</div>${expenses ? `<div class="expense-list">${expenses}</div>` : ""}<div class="totals"><div class="total"><span>Время</span><strong>${formatHours(data.totals.minutes)}</strong></div><div class="total"><span>Заработок</span><strong>${formatMoney(data.totals.incomeCents)}</strong></div><div class="total"><span>Расходы</span><strong>${formatMoney(data.totals.expensesCents)}</strong></div></div>`;
  $("#share-text").textContent = data.shareText;
  $("#backdated-warning").textContent = data.hasLaterEntries ? `После ${data.parsed.displayDate} уже есть записи. Их накопительные итоги будут пересчитаны после сохранения.` : "";
  $("#backdated-warning").hidden = !data.hasLaterEntries;
  $("#share-status").hidden = true;
  setTodayState("preview");
}

$("#preview-button").addEventListener("click", async () => {
  const button = $("#preview-button"); const error = $("#request-error"); error.hidden = true; button.disabled = true; button.textContent = "Собираю…";
  try { latestDayPayload = buildTodayPayload(); latestPreview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(latestDayPayload) }); if (!latestPreview.canShare) throw new Error("Проверьте заполненные работы"); daySaved = false; renderPreview(latestPreview); }
  catch (caught) { error.textContent = caught.message || "Не удалось сформировать отчёт."; error.hidden = false; }
  finally { button.disabled = false; button.textContent = "Сформировать отчёт"; }
});
$("#edit-button").addEventListener("click", () => { daySaved = false; setTodayState("editor"); });
async function saveTodayFromReport() { if (daySaved) return; const saved = await api("/api/days", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(latestDayPayload) }); latestPreview.shareText = saved.shareText; $("#share-text").textContent = saved.shareText; selectedPeriod = saved.day.dateIso.slice(0, 7); daySaved = true; }
$("#share-button").addEventListener("click", async () => { const status = $("#share-status"); try { await saveTodayFromReport(); if (navigator.share) { await navigator.share({ text: latestPreview.shareText }); status.className = "notice success"; status.textContent = "День сохранён, отчёт отправлен."; status.hidden = false; return; } await navigator.clipboard.writeText(latestPreview.shareText); status.className = "notice success"; status.textContent = "День сохранён, отчёт скопирован."; } catch { status.className = daySaved ? "notice success" : "notice error"; status.textContent = daySaved ? "День сохранён. Отправка отменена или недоступна." : "Не удалось сохранить день."; } status.hidden = false; });

function normalizeMapItems() {
  mapItems = [
    ...apartments.map((item) => ({ ...item, itemType: "apartment", kind: "apartment", name: item.canonicalName, note: item.noteBody })),
    ...savedPlaces.map((item) => ({ ...item, itemType: "place" })),
  ];
}

async function loadApartments(force = false) {
  if (apartments.length && !force) return;
  apartments = (await api("/api/apartments")).apartments;
}

async function loadMapItems(force = false) {
  if (mapItems.length && !force) { applyMapMode(); return; }
  try {
    await loadApartments(force);
    const placeData = productRelease >= 2 ? await api("/api/places") : { places: [] };
    savedPlaces = placeData.places; normalizeMapItems(); renderPlaceList(); renderPlacesMap(); fillApartmentSelect(); applyMapMode();
  } catch { $("#map-error").textContent = "Не удалось загрузить места."; $("#map-error").hidden = false; }
}

function applyMapMode() {
  if (!new Set(["map", "list"]).has(mapMode)) mapMode = "map";
  $("#map-mode-map").hidden = mapMode !== "map"; $("#map-mode-list").hidden = mapMode !== "list";
  $$('[data-map-mode]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mapMode === mapMode)));
  try { localStorage.setItem("maidaid:map-view", mapMode); } catch {}
  const url = new URL(location.href); url.searchParams.set("view", mapMode); history.replaceState({}, "", `${url.pathname}${url.search}`);
  if (mapMode === "map" && placesMap) setTimeout(() => placesMap.invalidateSize(), 0);
}
$$('[data-map-mode]').forEach((button) => button.addEventListener("click", () => { mapMode = button.dataset.mapMode; applyMapMode(); }));

function renderPlaceList() {
  const query = $("#place-search").value.trim().toLocaleLowerCase("ru"); const filter = $("#place-filter").value;
  const visible = mapItems.filter((item) => (filter === "all" || item.kind === filter) && (!query || [item.name, item.address, ...(item.aliases ?? [])].filter(Boolean).some((value) => String(value).toLocaleLowerCase("ru").includes(query)))).sort((a, b) => Number(!(a.itemType === "apartment" && a.latitude == null)) - Number(!(b.itemType === "apartment" && b.latitude == null)) || String(a.name).localeCompare(String(b.name), "ru"));
  $("#place-list").innerHTML = visible.length ? visible.map((item) => {
    const needsLocation = item.itemType === "apartment" && item.latitude == null;
    const genericLaundry = item.kind === "laundry" && ["сушка", "прачечная"].includes(String(item.name).trim().toLocaleLowerCase("ru"));
    const title = genericLaundry ? (item.address || "Адрес не указан") : item.name;
    const description = genericLaundry ? (item.latitude == null ? "Нужно указать местоположение" : "") : (item.address || (item.latitude == null ? "Нужно указать местоположение" : "Координаты сохранены"));
    const action = needsLocation
      ? `<button class="secondary" data-locate-apartment="${item.id}" type="button">Указать место</button>`
      : `<button class="secondary" data-open-item="${item.itemType}:${item.id}" type="button">Открыть</button>`;
    return `<article class="place-card"><div class="place-card-main"><span class="place-kind">${kindLabel(item.kind)}</span><strong>${escapeHtml(title)}</strong>${description ? `<p class="${item.latitude == null ? "missing-location" : ""}">${escapeHtml(description)}</p>` : ""}</div>${action}</article>`;
  }).join("") : "<p class=\"muted\">Ничего не найдено.</p>";
}
$("#place-search").addEventListener("input", renderPlaceList); $("#place-filter").addEventListener("change", renderPlaceList);
$("#place-list").addEventListener("click", (event) => {
  const locate = event.target.closest("[data-locate-apartment]");
  if (locate) { openEditForm(`apartment:${locate.dataset.locateApartment}`); return; }
  const button = event.target.closest("[data-open-item]"); if (button) openItemDetail(button.dataset.openItem);
});

function renderPlacesMap() {
  const host = $("#places-map");
  if (!globalThis.L) { $("#map-empty").textContent = "Карта не загрузилась. Список мест по-прежнему доступен."; $("#map-empty").hidden = false; return; }
  if (!placesMap) {
    placesMap = L.map(host, { zoomControl: true }).setView([48.8566, 2.3522], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(placesMap);
  }
  if (markerLayer) markerLayer.remove(); markerLayer = L.layerGroup().addTo(placesMap);
  const markerAppearance = {
    apartment: { colorClass: "apartment" },
    laundry: { colorClass: "laundry" },
    partner_restaurant: { colorClass: "partner_restaurant" },
  };
  const located = mapItems.filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude) && Math.abs(item.latitude) <= 90 && Math.abs(item.longitude) <= 180);
  located.forEach((item) => {
    const appearance = markerAppearance[item.kind] ?? markerAppearance.apartment;
    const icon = L.divIcon({
      className: "map-marker-icon",
      html: `<span class="map-marker map-marker--${appearance.colorClass}"></span>`,
      iconSize: [38, 44], iconAnchor: [19, 42], tooltipAnchor: [0, -34],
    });
    const marker = L.marker([item.latitude, item.longitude], { icon, title: item.name, alt: `${kindLabel(item.kind)}: ${item.name}`, riseOnHover: true }).addTo(markerLayer);
    const tooltip = document.createElement("span");
    const tooltipTitle = document.createElement("strong"); tooltipTitle.textContent = item.name; tooltip.append(tooltipTitle);
    if (item.address) { const tooltipAddress = document.createElement("small"); tooltipAddress.textContent = item.address; tooltip.append(tooltipAddress); }
    marker.bindTooltip(tooltip, { direction: "top", opacity: 1, className: "place-tooltip" });
    marker.on("click", () => openItemDetail(`${item.itemType}:${item.id}`));
  });
  if (located.length === 1) placesMap.setView([located[0].latitude, located[0].longitude], 15);
  else if (located.length) { const bounds = L.latLngBounds(located.map((item) => [item.latitude, item.longitude])); placesMap.fitBounds(bounds, { padding: [54, 54], maxZoom: 15 }); }
  $("#map-empty").hidden = located.length > 0; $("#map-empty").textContent = located.length ? "" : "Пока ни у одной квартиры нет координат. Откройте список и укажите местоположение.";
}

async function openItemDetail(key, push = true) {
  const [type, idText] = key.split(":"); const id = Number(idText);
  if (type === "apartment") return openApartmentDetail(id, push);
  const item = savedPlaces.find((place) => place.id === id); if (!item) return;
  const mapLink = mapsHref(item);
  const genericLaundry = item.kind === "laundry" && ["сушка", "прачечная"].includes(item.name.trim().toLocaleLowerCase("ru"));
  $("#place-detail").innerHTML = `<span class="place-kind">${kindLabel(item.kind)}</span><h2>${escapeHtml(genericLaundry ? (item.address || "Сушка") : item.name)}</h2>${!genericLaundry || !item.address ? `<p class="detail-address">${escapeHtml(item.address || "Адрес не указан")}</p>` : ""}${item.note ? `<p class="detail-note">${escapeHtml(item.note)}</p>` : ""}<div class="detail-actions">${mapLink ? `<a class="primary action-link" href="${escapeHtml(mapLink)}" target="_blank" rel="noopener noreferrer">Маршрут</a>` : ""}<button class="secondary" data-edit-item="place:${item.id}" type="button">Изменить</button><button class="ghost" data-archive-place="${item.id}" type="button">Архивировать</button></div>`;
  $("#place-detail-dialog").showModal();
}

async function openApartmentDetail(id, push = true) {
  try {
    const { apartment, preferredLaundry } = await api(`/api/apartments/${id}`);
    const mapLink = mapsHref(apartment);
    const editLabel = apartment.latitude == null ? "Указать место" : "Изменить";
    const releaseActions = `${productRelease >= 2 ? `<button class="secondary" data-choose-laundry="${apartment.id}" type="button">${preferredLaundry ? "Сменить сушку" : "Выбрать сушку"}</button>` : ""}<button class="ghost" data-edit-item="apartment:${apartment.id}" type="button">${editLabel}</button>`;
    const laundryTitle = preferredLaundry && ["сушка", "прачечная"].includes(String(preferredLaundry.name).trim().toLocaleLowerCase("ru")) ? (preferredLaundry.address || preferredLaundry.name) : preferredLaundry?.name;
    const laundryMapLink = preferredLaundry ? mapsHref(preferredLaundry) : null;
    const laundryCard = preferredLaundry ? `${laundryMapLink ? `<a class="notice success preferred-laundry-card" href="${escapeHtml(laundryMapLink)}" target="_blank" rel="noopener noreferrer">` : `<div class="notice success preferred-laundry-card">`}<strong>Выбранная сушка</strong><br>${escapeHtml(laundryTitle)}${laundryMapLink ? `<span>Открыть на карте →</span></a>` : "</div>"}` : "";
    $("#place-detail").innerHTML = `<span class="place-kind">Квартира</span><h2>${escapeHtml(apartment.canonicalName)}</h2><p class="detail-address ${apartment.latitude == null ? "missing-location" : ""}">${escapeHtml(apartment.address || (apartment.latitude == null ? "Нужно указать местоположение" : "Координаты сохранены"))}</p>${apartment.noteBody ? `<pre class="detail-note">${escapeHtml(apartment.noteBody)}</pre>` : ""}${laundryCard}<div class="detail-actions">${mapLink ? `<a class="primary action-link" href="${escapeHtml(mapLink)}" target="_blank" rel="noopener noreferrer">Маршрут</a>` : ""}${releaseActions}</div>`;
    $("#place-detail-dialog").showModal();
    if (push && location.pathname !== `/map/apartments/${id}`) history.pushState({}, "", `/map/apartments/${id}?view=${mapMode}`);
  } catch { $("#map-error").textContent = "Не удалось открыть квартиру."; $("#map-error").hidden = false; }
}

$("#place-detail").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-item]"); const archive = event.target.closest("[data-archive-place]"); const laundry = event.target.closest("[data-choose-laundry]");
  if (edit) { $("#place-detail-dialog").close(); openEditForm(edit.dataset.editItem); }
  if (archive && confirm("Убрать это место в архив?")) { await api(`/api/places/${archive.dataset.archivePlace}`, { method: "DELETE" }); $("#place-detail-dialog").close(); mapItems = []; await loadMapItems(true); }
  if (laundry) { $("#place-detail-dialog").close(); await openLaundryPicker(Number(laundry.dataset.chooseLaundry)); }
});

function resetPlaceForm() {
  $("#place-form").reset(); $("#place-edit-id").value = ""; $("#place-latitude").value = ""; $("#place-longitude").value = ""; $("#place-location-source").value = ""; $("#place-location-accuracy").value = "";
  $("#place-kind").disabled = false;
  $("#coordinate-picker").hidden = true; $("#place-form-error").hidden = true; $("#place-location-status").textContent = "Сначала попробуем определить точку по адресу.";
}
function clearDerivedLocation() {
  $("#place-latitude").value = ""; $("#place-longitude").value = ""; $("#place-location-source").value = ""; $("#place-location-accuracy").value = "";
  $("#place-location-status").textContent = "Местоположение будет определено по обновлённой ссылке или адресу.";
}
$("#place-address").addEventListener("input", clearDerivedLocation);
$("#place-maps-url").addEventListener("input", clearDerivedLocation);
function fillApartmentSelect() { $("#place-apartment-link").innerHTML = `<option value="">Не связывать</option>${[...apartments].sort((a, b) => Number(a.latitude != null) - Number(b.latitude != null) || a.canonicalName.localeCompare(b.canonicalName, "ru")).map((item) => `<option value="${item.id}">${escapeHtml(item.canonicalName)}${item.latitude == null ? " · не заполнена" : ""}</option>`).join("")}`; }
function updatePlaceKind() {
  const laundry = $("#place-kind").value === "laundry";
  $("#place-apartment-link-label").hidden = !laundry;
  $("#place-name").required = !laundry;
  $("#place-name-caption").textContent = laundry ? "Название (необязательно)" : "Название";
  $("#place-name").placeholder = laundry ? "Можно оставить пустым" : "";
}
$("#place-kind").addEventListener("change", updatePlaceKind);
function openPlaceForm(kind = "apartment", name = "") { resetPlaceForm(); $("#place-form-title").textContent = "Добавить место"; $("#place-kind").value = kind; $("#place-name").value = name; fillApartmentSelect(); updatePlaceKind(); $("#place-form-dialog").showModal(); }
$("#add-place-button").addEventListener("click", () => openPlaceForm());
function openEditForm(key) {
  const [type, idText] = key.split(":"); const id = Number(idText); const item = type === "apartment" ? apartments.find((entry) => entry.id === id) : savedPlaces.find((entry) => entry.id === id); if (!item) return;
  resetPlaceForm(); $("#place-form-title").textContent = "Изменить место"; $("#place-edit-id").value = key; $("#place-kind").value = item.kind ?? "apartment"; const genericLaundry = item.kind === "laundry" && ["сушка", "прачечная"].includes(String(item.name).trim().toLocaleLowerCase("ru")); $("#place-name").value = item.canonicalName ?? (genericLaundry ? "" : item.name); $("#place-address").value = item.address ?? ""; $("#place-maps-url").value = item.mapsUrl ?? ""; $("#place-note").value = item.noteBody ?? item.note ?? ""; $("#place-latitude").value = item.latitude ?? ""; $("#place-longitude").value = item.longitude ?? ""; $("#place-location-source").value = item.locationSource ?? ""; updatePlaceKind(); $("#place-form-dialog").showModal();
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
      return `<article class="ledger-row"><time>${escapeHtml(row.dateIso)}</time><div><strong>${formatHours(row.minutes)} работы</strong><br><small>${formatMoney(row.incomeCents)} заработано · ${formatMoney(row.expensesCents)} расходы</small></div><div class="ledger-row-actions"><button class="secondary" data-edit-day="${row.dateIso}">Изменить</button><button class="ghost" data-delete-day="${row.dateIso}">Удалить</button></div><div class="ledger-day-tabs"><details class="ledger-day-details"><summary>Расписание</summary><pre>${escapeHtml(row.sourceText)}</pre></details><details class="ledger-day-details"><summary>Отчёт</summary><pre>${escapeHtml(row.reportText || "Отчёт не сохранён")}</pre></details><details class="ledger-day-details"><summary>Подробнее</summary><div class="ledger-detail-list">${details || "Работы не найдены"}</div></details></div></article>`;
    }
    const manual = row.source === "manual"; return `<article class="ledger-row"><time>${row.dateIso}</time><div><strong>${formatMoney(row.amountCents)} получено</strong><br><small>${escapeHtml(row.note || (manual ? "Ручная оплата" : "Аванс из отчёта"))}</small></div>${manual ? `<div class="ledger-row-actions"><button class="secondary" data-edit-payment="${row.id}" data-date="${row.dateIso}" data-amount="${row.amountCents}" data-note="${escapeHtml(row.note || "")}">Изменить</button><button class="ghost" data-delete-payment="${row.id}">Удалить</button></div>` : "<span class=\"muted\">Из текста</span>"}</article>`;
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
